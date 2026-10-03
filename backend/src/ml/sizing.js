/**
 * Continuous position sizing and risk overlay.
 *
 * The problem: a classifier that outputs 0.67 is being flattened into "buy
 * 100% or buy nothing". That throws away the single most useful piece of
 * information the model produced. A 0.67 call deserves *more* size than a
 * 0.56 call, not the same size — sizing continuously is what converts a
 * prediction into a position.
 *
 * Method follows AFML ch. 10: map the probability to a z-score, then through
 * the normal CDF to a bet size in [-1, 1].
 *
 * Risk overlay: FinRL's *turbulence* index (a Mahalanobis-style distance on
 * recent returns) is the one macro stress gate worth carrying across from the
 * reviewed codebases. When the market is behaving unlike its own recent past,
 * size is cut regardless of how confident the model is.
 */

import { normalCDF } from "./stats.js";

/**
 * Map P(up) to a continuous position in [-1, 1].
 *
 * The z-statistic is how far the probability sits from a coin flip, scaled by
 * the maximum possible deviation, so 0.5 maps to 0 and both extremes saturate
 * near ±1 without ever being clipped hard.
 *
 * @param p model probability of an up move
 * @returns size in [-1, 1]; 0 means stay flat
 */
export function betSize(p) {
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return 0;
  // A probability that is a coin flip to within float noise is a coin flip.
  // Without this, Φ(0) leaves ~1e-9 behind and a "no bet" decision becomes a
  // dust trade that still pays a fee.
  if (Math.abs(p - 0.5) < 1e-6) return 0;
  // Guard the clipping: at exactly 0 or 1 the denominator collapses to zero.
  const clipped = Math.min(0.999, Math.max(0.001, p));
  const z = (clipped - 0.5) / Math.sqrt(clipped * (1 - clipped));
  return 2 * normalCDF(z) - 1;
}

/**
 * Turbulence index: the Mahalanobis distance of the current return vector from
 * the mean of recent returns, scaled by the covariance of that window.
 *
 * Implemented with a single-series approximation (a diagonal covariance) rather
 * than a full matrix inverse. For one asset over a rolling window this tracks
 * the real statistic closely and costs O(n) instead of O(n³).
 */
export function turbulenceIndex(returns, window = 30) {
  const recent = returns.slice(-window);
  if (recent.length < 5) return 0;
  const mean = recent.reduce((s, r) => s + r, 0) / recent.length;
  let variance = 0;
  for (const r of recent) variance += (r - mean) ** 2;
  variance /= recent.length;
  // An epsilon, not an equality test: a flat series accumulates denormal
  // float noise rather than a true zero, and dividing by its square root
  // turns that noise into a spurious reading.
  if (!(variance > 1e-12)) return 0;
  return Math.abs(recent[recent.length - 1] - mean) / Math.sqrt(variance);
}

/**
 * Kelly fraction for a binary bet — the fraction of bankroll that maximises the
 * long-run geometric growth rate.
 *
 * From the probability side of the quant literature rather than the trading
 * side, because it is the one formula there that changes how a trading app
 * behaves: it says the *optimal* size is a function of both your edge and the
 * payoff, and that betting more than it is strictly worse than betting less, not
 * merely riskier. f* = p - q/b, where b is the win/loss payoff ratio.
 *
 * Note what it assumes: that `p` is the true probability. Every probability in
 * this app is an estimate with a standard error, and Kelly is unforgiving of an
 * overestimated p — at the true-optimal f you lose everything on a streak of
 * length you will eventually see. Hence `kellySize` below, which is the only
 * version the app uses.
 */
export function kellyFraction(p, payoffRatio = 1) {
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return 0;
  if (!(payoffRatio > 0)) return 0;
  const q = 1 - p;
  const f = p - q / payoffRatio;
  // A negative edge is an instruction to stand flat, not to bet the other way
  // on a signal we do not have a directional claim about.
  return f > 0 ? f : 0;
}

/**
 * The size the app actually uses: fractional Kelly against a volatility target.
 *
 * Three deliberate haircuts, each cutting the same way, and each needed because
 * the inputs here are estimates rather than truths:
 *
 *  1. **Fraction (default 0.25).** Full Kelly assumes `p` is exact and bets a
 *     size that, with an overestimated p, is *beyond* the point where growth
 *     turns negative. Quarter Kelly keeps most of the growth of a correct f*
 *     while being robust to the estimate being wrong, which it is.
 *  2. **Volatility targeting.** Vol is the only quantity in the research pass
 *     that proved predictable (rank IC 0.187). Sizing inversely to forecast vol
 *     means a position carries the same risk whether the market is calm or
 *     violent, which is the whole point: the edge is in the signal, so letting
 *     realised risk scale with market turbulence scales the *losses* with it too.
 *  3. **Hard cap.** No estimate is worth a large fraction of the account.
 *
 * @param p            model probability of the favourable outcome
 * @param opts         `{ payoffRatio, fraction, forecastVol, targetVol, cap }`
 * @returns fraction of bankroll in [0, cap]
 */
export function kellySize(p, { payoffRatio = 1, fraction = 0.25, forecastVol = null, targetVol = null, cap = 0.25 } = {}) {
  const full = kellyFraction(p, payoffRatio);
  if (full <= 0) return 0;
  let size = full * fraction;
  // Scale by target/forecast: a twice-as-volatile market halves the position.
  // Guarded on both being usable, because a zero vol estimate (a flat series)
  // would otherwise divide into infinity and size the largest position on record
  // for the market that has stopped moving.
  if (forecastVol > 0 && targetVol > 0) size *= Math.min(2, targetVol / forecastVol);
  return Number(Math.min(cap, size).toFixed(4));
}

/**
 * Should this be traded at all? Compares the expected move over the holding
 * period against the cost of entering and exiting.
 *
 * This is the cheapest profitable filter available to the app and it requires no
 * directional skill whatsoever, which is why it exists. If fees plus spread
 * exceed what the horizon is likely to move, then *no* signal, however good, can
 * be monetised at that horizon on that venue — the trade loses money on average
 * before any model is consulted. On long-tail Solana tokens, where spread rather
 * than fee dominates, this is frequently the binding constraint.
 */
export function clearsCost({ expectedMove, roundTripCostBps = 34, margin = 1.5 } = {}) {
  if (!Number.isFinite(expectedMove) || expectedMove <= 0) return { clears: false, expectedMove: 0, cost: roundTripCostBps / 1e4 };
  const cost = roundTripCostBps / 1e4;
  // A margin, not an equality: at expected-move == cost the edge is exactly
  // consumed by the spread, and slippage on top makes that a certain loser.
  const clears = expectedMove >= cost * margin;
  return { clears, expectedMove: Number(expectedMove.toFixed(6)), cost, margin };
}

/**
 * Turn a probability into a notional, after risk limits.
 *
 * @param prob           model probability of an up move
 * @param maxNotional    hard cap in USD
 * @param turbulence     current turbulence index
 * @param threshold      level above which the market is considered stressed
 * @param stressScale    multiplier applied in a stressed regime (0 = stand down)
 */
export function sizePosition(prob, { maxNotional = 100, turbulence = 0, threshold = 3, stressScale = 0.25 } = {}) {
  const raw = betSize(prob);
  const stressed = turbulence > threshold;
  // A zero bet is FLAT in both name and reporting, so a reader never sees a
  // "BUY" row that is not actually a position.
  if (raw === 0) return { notional: 0, direction: "FLAT", size: 0, stressed };
  // FinRL-style stress gate: a great signal in a broken market is still a
  // bad trade, so size is cut rather than merely flagged.
  const scale = stressed ? stressScale : 1;
  const notional = maxNotional * Math.abs(raw) * scale;
  return {
    notional: Number(notional.toFixed(2)),
    direction: raw > 0 ? "BUY" : "SELL",
    size: Number((raw * scale).toFixed(4)),
    stressed,
  };
}