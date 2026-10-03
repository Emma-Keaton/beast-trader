/**
 * Feeding the circuit breaker from realised outcomes.
 *
 * The problem this closes. `circuit.js` implements a full breaker — drawdown from
 * the high-water mark, consecutive losses, stale data, manual halt — and every
 * gate checks it on every order. But nothing in the app ever *called*
 * `recordTrade` or `updateEquity`. The breaker was a guage with no fuel: always
 * closed, permanently green, and structurally incapable of stopping anything.
 *
 * That matters more than it looks. Every other safety control in this codebase
 * operates *before* an order: promotion gates, risk limits, the readiness check.
 * All of them assume the model is good. This one is the only control that acts
 * *after* reality has contradicted that assumption, and it is the only thing
 * standing between a model that passes every static gate and an account emptied
 * at three in the morning while nobody is watching.
 *
 * A model can satisfy every rule in `strategies.js` and still blow up on live
 * prices, because the gates are evaluated on paper. This is what notices.
 */

import { getBreaker } from "./circuit.js";

/**
 * Update the breaker from one settled outcome.
 *
 * `pnl` is a fraction of equity, positive for a gain. Called for paper calls and
 * real fills alike: the point is to notice when the *strategy* is wrong, and
 * whether the money was real or simulated does not change that.
 *
 * Returns the breaker's state afterwards so a caller can react — chiefly, to stop
 * proposing or placing further orders in the same pass.
 */
export function feedBreaker(pnl) {
  if (!Number.isFinite(pnl)) return getBreaker().state;
  return getBreaker().recordTrade(pnl);
}

/**
 * Update the high-water mark from a realised equity value.
 *
 * Separate from `feedBreaker` because they answer different questions: the
 * trade stream catches "losing repeatedly", and the equity curve catches "down a
 * lot overall". A strategy can be winning most trades and still bleeding, and only
 * the equity figure sees that.
 */
export function feedEquity(value) {
  if (!Number.isFinite(value)) return getBreaker().state;
  return getBreaker().updateEquity(value);
}

/**
 * Fold a batch of settled outcomes into the breaker.
 *
 * Used when the improvement cycle settles a window of calls at once, which is the
 * normal cadence — the poller settles individually, but a backfill or a restart
 * can settle many retroactively. Idempotent in the sense that matters: replaying
 * the same window twice would double-count losses, so the caller is expected to
 * feed only outcomes it has not already reported.
 *
 * @returns `{ state, trips, consecutiveLosses }` so the caller can log what the
 *   breaker did rather than discovering it later as a halted app.
 */
export function feedOutcomes(outcomes) {
  const list = (outcomes ?? []).filter((o) => Number.isFinite(o?.pnl ?? o));
  if (!list.length) return { state: getBreaker().state, trips: [], consecutiveLosses: 0 };
  const trips = [];
  let equity = 1;
  for (const o of list) {
    const pnl = Number(o.pnl ?? o);
    equity *= 1 + pnl;
    const before = getBreaker().state;
    const state = getBreaker().recordTrade(pnl);
    getBreaker().updateEquity(equity);
    // Recorded only on a transition, so a run of losses produces one trip rather
    // than one per trade, which would make the log unreadable.
    if (before !== state && state !== before) trips.push({ at: o.at ?? null, pnl, state });
  }
  const b = getBreaker();
  return { state: b.state, trips, consecutiveLosses: b.consecutiveLosses };
}

/** Reset. Manual recovery only — a tripped breaker never clears itself. */
export function resetBreaker() {
  const b = getBreaker();
  b.state = "closed";
  b.reason = "";
  b.equity = null;
  b.peak = null;
  b.consecutiveLosses = 0;
  b.trippedAt = null;
  b.history = [];
  return b;
}

/** A one-line description of why trading is halted, or that it is not. */
export function breakerSummary() {
  const b = getBreaker();
  return {
    state: b.state,
    reason: b.reason,
    canTrade: b.state === "closed",
    consecutiveLosses: b.consecutiveLosses,
    drawdown: b.peak != null && b.peak > 0 ? Number(((b.peak - (b.equity ?? b.peak)) / b.peak).toFixed(4)) : 0,
  };
}
