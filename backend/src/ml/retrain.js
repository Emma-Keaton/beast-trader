/**
 * Continuous retraining from the app's own live outcomes.
 *
 * This is the loop that makes the app improve over time without anyone
 * re-running a training script. It works from data nothing else has: the
 * **settled paper calls**. Each one carries the exact feature vector that was
 * computed at prediction time and the price it actually reached — forward
 * looking, fee-bearing, and never seen by the model that produced it.
 *
 * That makes the paper ledger a training set, not just a scoreboard.
 *
 * The loop is deliberately conservative:
 *
 *  1. A cycle only runs when enough calls have settled. Below the floor, any
 *     "improvement" is noise.
 *  2. Training happens on a chronological split, holding the most recent
 *     settled calls out as a test set the fit never saw.
 *  3. The result is **proposed as a challenger**, never installed. Promotion is
 *     a separate decision in `strategies.js` that requires beating the
 *     champion's own live track record.
 *
 * So a bad week produces a challenger that is measured and rejected. It never
 * quietly replaces a working model, which is the failure mode that makes naive
 * "keep retraining" dangerous.
 */

import { fit, predictProbability } from "./logistic.js";
import { returnMoments, deflatedSharpeRatio } from "./stats.js";
import { proposeChallenger, listChallengers, evaluatePromotion, recordChallengerOutcome, getChampion } from "./strategies.js";

/** Below this many settled calls, a retrain is fitting noise. */
export const MIN_SETTLED_FOR_RETRAIN = 60;

/** Never retrain more often than this, however often the poller ticks. */
const RETRAIN_COOLDOWN_MS = 6 * 3600_000;

let lastRetrainAt = 0;
export function resetRetrainClock() {
  lastRetrainAt = 0;
}

/**
 * Turn settled paper calls into a training set.
 *
 * Only calls that carry a feature vector are usable — ones recorded before
 * this feature existed are skipped rather than faked, because a row with an
 * imputed input teaches the model nothing real.
 */
export function trainingSetFromCalls(calls) {
  const X = [];
  const y = [];
  const fwd = [];

  for (const c of calls) {
    if (!Array.isArray(c.features) || !c.features.length) continue;
    if (!Number.isFinite(c.exit_price) || !Number.isFinite(c.entry_price) || c.entry_price <= 0) continue;
    // The net return the app actually recorded, fees included. The model is
    // trained on the outcome it will be judged on, not a frictionless one.
    const net = Math.log(c.exit_price / c.entry_price) * (c.side === "LONG" ? 1 : -1);
    if (!Number.isFinite(net)) continue;
    X.push(c.features.map((v) => (Number.isFinite(v) ? v : 0)));
    y.push(net > 0 ? 1 : 0);
    fwd.push(net);
  }
  return { X, y, fwd, rows: X.length };
}

/**
 * Reshape settled orders into the same shape `trainingSetFromCalls` consumes,
 * so an executed trade is a first-class training example.
 *
 * Orders used to be a display log only. That is a real loss of evidence: an
 * order is the only record the app keeps of what it *actually did* — the
 * direction it chose, the size it sized, the price it filled at. Paper calls
 * are a rehearsal of that decision; the order is the decision itself.
 *
 * Both sources are merged, and deliberately not deduplicated. A call and an
 * order for the same symbol in the same window are two independent samples of
 * the same decision process, and collapsing them would bias the training set
 * toward whatever the autopilot happened to trade.
 *
 * Rows without a feature vector are skipped, exactly as for paper calls: a row
 * with an imputed input teaches the model nothing real.
 */
export function normaliseOrders(orders) {
  const out = [];
  for (const o of orders ?? []) {
    if (!Array.isArray(o.features) || !o.features.length) continue;
    const entry = Number(o.filled_price ?? o.limit_price);
    const exit = Number(o.exit_price);
    if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(exit)) continue;

    // BUY is long, SELL is short. Anything else has no direction to learn from.
    const dir = o.side === "BUY" ? 1 : o.side === "SELL" ? -1 : 0;
    if (!dir) continue;

    out.push({
      entry_price: entry,
      exit_price: exit,
      side: dir > 0 ? "LONG" : "SHORT",
      features: o.features,
      // Retained so a mixed dataset stays auditable: when a training set is
      // half orders and half calls, provenance is how you tell which is which.
      source: "order",
      mode: o.mode ?? null,
      symbol: o.symbol ?? null,
      settled_at: o.settled_at ?? o.created_at ?? null,
    });
  }
  return out;
}

/**
 * One retraining cycle.
 *
 * @param calls settled paper calls, any order (oldest-first is applied here)
 * @param opts  `{ force }` to ignore the cooldown
 * @returns a report, including a "why not" when it declines to run
 */
export async function retrain(calls, opts = {}) {
  const now = Date.now();
  if (!opts.force && now - lastRetrainAt < RETRAIN_COOLDOWN_MS) {
    return { ran: false, reason: "cooldown — a retrain ran recently" };
  }

  // Oldest first: the chronological split below depends on the ordering.
  const ordered = trainingSetFromCalls([...(calls ?? [])].reverse());
  if (ordered.rows < MIN_SETTLED_FOR_RETRAIN) {
    return {
      ran: false,
      reason: `only ${ordered.rows} usable settled calls, need ${MIN_SETTLED_FOR_RETRAIN}`,
      rows: ordered.rows,
    };
  }

  // Hold out the most recent 30% as a test set the fit never sees.
  const cut = Math.floor(ordered.X.length * 0.7);
  const Xtr = ordered.X.slice(0, cut);
  const ytr = ordered.y.slice(0, cut);
  const Xte = ordered.X.slice(cut);
  const yte = ordered.y.slice(cut);
  const fte = ordered.fwd.slice(cut);

  if (Xte.length < 20) {
    return { ran: false, reason: "not enough held-out calls to judge a retrain", rows: ordered.rows };
  }

  // Feature names are metadata about *these* columns. Names inherited from a
  // model trained on a different feature set would label this one's columns
  // wrongly — and `fit` now refuses to store mismatched names outright — so
  // take them only when the width agrees, otherwise claim none and let `fit`
  // attach the canonical names for this width (or honest positional labels
  // for an unlabeled layout). The improvement cycle must keep running when
  // the feature layout evolves between models.
  const width = Xtr[0]?.length ?? 0;
  const inherited = getChampion()?.features ?? listChallengers()[0]?.features ?? null;
  const featureNames = Array.isArray(inherited) && inherited.length === width ? inherited : null;
  const model = fit(Xtr, ytr, { epochs: 300, featureNames });

  // Score the new weights on data they were never fitted to. Unlike
  // `evaluateRows`, this does *not* refit anything — the weights are already
  // fixed, and all that is left is to measure them honestly.
  const verdict = scoreFixed(model, Xte, yte, fte);
  if (!verdict.ok) {
    return { ran: false, reason: `evaluation failed: ${verdict.reason}`, rows: ordered.rows };
  }

  lastRetrainAt = now;
  const challenger = await proposeChallenger(model, {
    label: `retrain-${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
    provenance: "retrain-from-paper",
  });

  return {
    ran: true,
    challenger: challenger.id,
    trained_on: Xtr.length,
    held_out: Xte.length,
    accuracy: verdict.accuracy,
    expectancy: verdict.expectancy,
    winRate: verdict.winRate,
    deflated_sharpe: verdict.deflated_sharpe,
  };
}

/**
 * Score an already-fitted model on a held-out set.
 *
 * This is deliberately separate from `evaluateRows`, which refits per fold and
 * is therefore the right tool for training but the wrong one here: the weights
 * from `fit()` are already decided, and refitting them would score a different
 * model than the one actually being proposed.
 */
export function scoreFixed(model, X, y, fwd, cfg = {}) {
  const { feePct = 0.001, slippagePct = 0.0005, minConfidence = 0.55 } = cfg;

  if (!X.length || X.length !== y.length || X.length !== fwd.length) {
    return { ok: false, reason: "held-out set is empty or ragged" };
  }

  const probs = X.map((r) => predictProbability(model, r));
  if (probs.some((p) => !Number.isFinite(p))) {
    return { ok: false, reason: "model produced a non-finite probability" };
  }

  const correct = probs.filter((p, i) => (p >= 0.5 ? 1 : 0) === y[i]).length;

  // Trade only where the call is meaningfully away from a coin flip, paying the
  // same costs the app charges in production.
  const rets = [];
  for (let i = 0; i < probs.length; i++) {
    if (Math.abs(probs[i] - 0.5) * 2 < minConfidence) continue;
    rets.push((probs[i] >= 0.5 ? 1 : -1) * fwd[i] - feePct - slippagePct);
  }

  // DSR is computed from this held-out track record's own moments. Combing a
  // fold's Sharpe together with aggregate returns from a different sample
  // describes a strategy that never existed.
  let sharpe = 0;
  if (rets.length >= 4) {
    const m = returnMoments(rets);
    sharpe = deflatedSharpeRatio(m.sharpe, [], m.T, m.skewness, m.kurtosis).dsr;
  }

  return {
    ok: true,
    rows: X.length,
    trades: rets.length,
    accuracy: correct / X.length,
    brier: probs.reduce((s, p, i) => s + (p - y[i]) ** 2, 0) / probs.length,
    expectancy: rets.length ? rets.reduce((s, x) => s + x, 0) / rets.length : 0,
    winRate: rets.length ? rets.filter((r) => r > 0).length / rets.length : 0,
    deflated_sharpe: sharpe,
  };
}

/**
 * Score every live prediction against every challenger, so each accrues its own
 * track record from the same outcomes.
 *
 * This is what makes the comparison fair: all candidates are judged on the
 * identical calls, at the same time, at the same prices.
 */
export async function scoreChallengersOn(calls) {
  const challengers = listChallengers();
  if (!challengers.length || !calls?.length) return;

  for (const c of challengers) {
    if (!c.scaler || !Array.isArray(c.weights)) continue;
    // A corrupt artefact must not accrue a track record. `predictProbability`
    // sanitises non-finite inputs and returns a plausible-looking number, so
    // checking its output alone would let a broken model earn a score.
    const intact =
      c.weights.every(Number.isFinite) &&
      Number.isFinite(c.bias ?? 0) &&
      Array.isArray(c.scaler?.mean) &&
      Array.isArray(c.scaler?.std) &&
      c.scaler.mean.length === c.weights.length &&
      c.scaler.std.length === c.weights.length;
    if (!intact) continue;

    for (const call of calls) {
      if (!Array.isArray(call.features) || !call.features.length) continue;
      if (!Number.isFinite(call.exit_price) || !Number.isFinite(call.entry_price) || call.entry_price <= 0) continue;
      const model = { scaler: c.scaler, weights: c.weights, bias: c.bias, calib: c.calib };
      const p = predictProbability(model, call.features);
      if (!Number.isFinite(p)) continue;
      // What direction *this* challenger would have taken, against what the
      // coin actually did, paying the same costs the app charges.
      const dir = p >= 0.5 ? 1 : -1;
      const coinMoved = Math.log(call.exit_price / call.entry_price);
      await recordChallengerOutcome(c.id, dir * coinMoved - 0.0015);
    }
  }
}

/**
 * A full improvement cycle: score the challengers, consider a promotion, and
 * retrain if the accumulated data supports it.
 */
export async function improvementCycle(calls, championStats = null, opts = {}) {
  await scoreChallengersOn(calls);
  const promotion = evaluatePromotion(championStats);
  const trained = await retrain(calls, opts);
  return { promotion, trained, at: new Date().toISOString() };
}
