/**
 * Prediction layer.
 *
 * Two tiers, chosen automatically by what data is available:
 *
 *  1. **Trained model (preferred).** When a coin has enough recent history
 *     and a trained model is on disk, features are built from the price
 *     series and scored by the calibrated direction model. This is the path
 *     that has a measured, out-of-sample hit rate.
 *  2. **Simple rules (fallback).** Momentum + liquidity heuristics that need
 *     only a live quote. Always available, never fails, and keeps
 *     thin-liquidity tokens safe.
 *
 * Both tiers return the identical contract, so the executor, poller and UI
 * don't care which one ran:
 *
 *   { signal: "LONG" | "SHORT" | "HOLD",
 *     confidence: 0..1,          // calibrated; the UI's risk dial
 *     target_price: number|null,
 *     stop_price: number|null,
 *     horizon: "24h",
 *     reason: string,            // plain language, safe for a beginner
 *     model: string,             // which tier produced this
 *     basis: "model" | "rules" }
 *
 * `reason` is deliberately non-technical: a new trader should be able to
 * read the sentence and understand the trade without knowing what an
 * oscillator is.
 */

import { buildFeatures, WARMUP } from "../ml/features.js";
import { getModel } from "../ml/registry.js";
import { predictProbability } from "../ml/logistic.js";
import { turbulenceIndex } from "../ml/sizing.js";
import { forecast, toPrediction, STRATEGIC_HORIZON } from "../ml/forecast.js";
import { predictWithKronos, kronosEnabled } from "../ml/kronos.js";

/** Probability band that becomes HOLD. 0.5 = coin flip. */
const LONG_AT = 0.56;
const SHORT_AT = 0.44;
const MIN_HISTORY = WARMUP + 10; // bars required before the model will speak

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

/**
 * Model tier: score a coin from its own recent price history.
 * Returns null when history is too short or no model is trained, which hands
 * control back to the rules tier.
 */
export function predictFromSeries(bars, meta = {}) {
  const model = getModel();
  if (!model) return null;
  if (!Array.isArray(bars) || bars.length < MIN_HISTORY) return null;

  const { features } = buildFeatures(bars);
  if (!features.length) return null;

  const latest = features[features.length - 1];
  const p = predictProbability(model, latest);
  const price = bars[bars.length - 1].c;

  let signal = "HOLD";
  if (p >= LONG_AT) signal = "LONG";
  else if (p <= SHORT_AT) signal = "SHORT";

  // Liquidity is a safety gate applied on top of the model, never instead of
  // it: a great-looking signal on a coin nobody can sell is not a trade.
  const liquidity = Number(meta.liquidity_usd ?? 0);
  if (liquidity > 0 && liquidity < 20_000 && signal !== "HOLD") {
    return {
      signal: "HOLD",
      probability: 0.5,
      confidence: 0.2,
      target_price: null,
      stop_price: null,
      horizon: "24h",
      reason: "Too few buyers on this coin right now, so we are not trading it.",
      model: `${model.kind || "logistic"}-v${model.version ?? 2}`,
      basis: "rules",
    };
  }

  const recent = meta.history ?? [];
  // Rolling market turbulence: how far the latest bar sits from the recent
  // mean, in units of recent volatility. A spike means the market is moving
  // unlike itself, so size is cut even on a confident signal.
  const turbulence = turbulenceIndex(recent.slice(-31).map((b, i, arr) => (i === 0 || !arr[i - 1]?.c ? 0 : b.c / arr[i - 1].c - 1)));

  return {
    signal,
    // The raw P(up) is passed through so the executor can size continuously
    // instead of treating every non-HOLD call as an all-in bet.
    probability: Number(p.toFixed(4)),
    confidence: Number(clamp01(Math.abs(p - 0.5) * 2).toFixed(3)),
    turbulence: Number(turbulence.toFixed(3)),
    target_price: targetFrom(price, signal),
    stop_price: stopFrom(price, signal),
    horizon: "24h",
    reason: explain(signal, p, meta),
    model: `${model.kind || "logistic"}-v${model.version ?? 2}`,
    basis: "model",
    // The exact vector this call was scored on. `openCall` stores it so that
    // when the call settles, the pair (features, realised return) becomes a
    // training example for the retrainer. Without this the improvement loop
    // has nothing to learn from and would silently stay idle forever.
    features: latest,
  };
}

/**
 * Rules tier: momentum from the last 24h move, gated on tradeable liquidity.
 * Needs nothing but a live quote, so it never goes dark.
 */
export function predictFromSnapshot(snap) {
  const chg = Number(snap.change_24h ?? 0);
  const price = Number(snap.price_usd ?? 0);
  const abs = Math.min(Math.abs(chg), 15) / 15;

  let signal = "HOLD";
  if (abs >= 0.12) signal = chg > 0 ? "LONG" : "SHORT";

  const liquidity = Number(snap.liquidity_usd ?? 0);
  const isDex = Boolean(snap.dex) || (snap.chain && snap.chain !== "coingecko");
  if (isDex && liquidity < 20_000 && signal !== "HOLD") signal = "HOLD";

  // The rules tier also has to emit a probability, or continuous position
  // sizing silently falls back to full-size for every DEX coin — exactly the
  // assets where size matters most. Momentum is mapped onto the same [0,1]
  // scale the model uses, capped at 10% so a meme coin cannot imply certainty.
  const probability = Number(clamp01(0.5 + (chg / 20)).toFixed(4));

  return {
    signal,
    probability,
    confidence: Number(clamp01(signal === "HOLD" ? 0.3 + abs : 0.5 + abs * 0.45).toFixed(3)),
    target_price: price ? targetFrom(price, signal) : null,
    stop_price: price ? stopFrom(price, signal) : null,
    horizon: "24h",
    reason: explainRules(signal, chg, liquidity, isDex),
    model: isDex ? "solana-v2" : "crypto-v2",
    basis: "rules",
  };
}

/** Entry point used by the research service: model first, rules as backstop. */
export function predict(snapshot) {
  return predictFromSeries(snapshot.history, snapshot) || predictFromSnapshot(snapshot);
}

/**
 * Async entry point: Kronos sidecar first when KRONOS_SERVICE_URL is set,
 * with the local model tier and rules as automatic fallbacks. Never throws;
 * a sidecar outage degrades to the sync predict() path, never to a crash.
 */
export async function predictBest(snapshot) {
  if (kronosEnabled()) {
    const k = await predictWithKronos(snapshot?.history, snapshot);
    if (k) return k;
  }
  return predict(snapshot);
}

/**
 * The ensemble forecast, run alongside the primary prediction.
 *
 * This is deliberately **not** wired into the trading decision. It is recorded
 * so it can be scored against the same settled calls as the primary model, and
 * promoted only if it earns that on evidence.
 *
 * That separation is the whole point. On a walk-forward test over the app's own
 * cached history, the ensemble scored 49.5% — a coin flip — and its confidence
 * was *anti-correlated* with accuracy: above 0.4 confidence it hit 44.2%.
 * Trusting it would be worse than random. So it runs, it records, it gets
 * measured, and it earns its place the same way any other model would.
 *
 * The follow-up research pass (`scripts/research.js`) found the likely mechanism
 * rather than assuming bad luck: it was being asked at 3 bars when the pattern it
 * keys on needs 2-4 weeks to show up, so it was confidently reading noise. Two
 * changes follow from that and neither is tuned to a number — the horizon moved to
 * STRATEGIC_HORIZON, and the mean-reversion member, whose premise the data
 * contradicts, no longer votes. Whether that fixed it is an open empirical
 * question that the scoreboard answers over weeks of settled calls, not here.
 */
export function forecastEnsemble(snapshot) {
  const bars = snapshot?.history;
  if (!Array.isArray(bars) || bars.length < 30) return null;
  const closes = bars.map((b) => b?.c).filter((c) => Number.isFinite(c) && c > 0);
  if (closes.length < 30) return null;
  // The horizon was 3 until the research pass measured that the signal this
  // ensemble keys on needs 2-4 weeks to express and is a coin flip at 3-7 days.
  return forecast(closes, { horizon: STRATEGIC_HORIZON });
}

/**
 * Both models' opinions on one snapshot, for the scoreboard and the UI.
 *
 * Kept out of `predict()` on purpose: the trading decision must not silently
 * change because a second model was added. Changing what trades is an explicit
 * promotion through the registry, not a side effect of shipping a new module.
 */
export function predictAll(snapshot) {
  const primary = predict(snapshot);
  const f = forecastEnsemble(snapshot);
  return {
    primary,
    ensemble: f ? { forecast: f, prediction: toPrediction(f) } : null,
  };
}

// ── plain-language explanations ───────────────────────────────────────────

/** Maps a probability into a sentence a first-time trader can read. */
function explain(signal, p, meta) {
  const pct = Math.round(p * 100);
  if (signal === "LONG") return `The AI sees an upward trend and puts a ${pct}% chance of a rise in the next day.`;
  if (signal === "SHORT") return `The AI sees a downward trend and puts a ${100 - pct}% chance of a fall in the next day.`;
  const chg = meta?.change_24h;
  if (chg == null) {
    return "There is not enough trading activity to make a call, so we are waiting.";
  }
  if (Math.abs(chg) < 1) {
    return "This coin is barely moving today, so there is nothing worth trading yet.";
  }
  const move = `${chg >= 0 ? "up" : "down"} ${Math.abs(chg).toFixed(1)}%`;
  return `It has moved ${move} today, but the signs don't agree yet, so we are waiting.`;
}

function explainRules(signal, chg, liquidity, isDex) {
  const move = `${chg >= 0 ? "+" : ""}${chg.toFixed(1)}%`;
  if (signal === "HOLD") {
    if (isDex && liquidity < 20_000) {
      return "Not enough buyers on this coin yet, so we are not trading it.";
    }
    if (Math.abs(chg) < 1) {
      return `It has barely moved today (${move}), so we are waiting for something clearer.`;
    }
    // A large move with no verdict means the signals disagree, which is a
    // different (and more honest) thing to say than "going sideways".
    return `It has moved ${move} today, but the signs don't agree yet, so we are waiting.`;
  }
  if (signal === "LONG") return `It is up ${move} today. The trend is with it, so the AI leans toward buying.`;
  return `It is down ${move} today. The trend is against it, so the AI leans toward selling.`;
}

// ── price levels ──────────────────────────────────────────────────────────

/** A modest, realistic target: 2% in the signal's direction. */
function targetFrom(price, signal) {
  if (!price || signal === "HOLD") return null;
  return round(price * (signal === "LONG" ? 1.02 : 0.98));
}

/** Protective stop 5% away — the "if I'm wrong, I lose little" line. */
function stopFrom(price, signal) {
  if (!price || signal === "HOLD") return null;
  return round(price * (signal === "LONG" ? 0.95 : 1.05));
}

function round(n) {
  return Number(n.toFixed(8));
}
