
/**
 * Drawdown and stability of a challenger's track record.
 *
 * Why this exists. The promotion rules were built entirely on *average* behaviour:
 * expectancy, win rate, deflated Sharpe. Every one of those is blind to the shape
 * of the losses. A strategy that wins small and occasionally loses everything
 * averages out fine — and will eventually do exactly that, unattended, with real
 * money, while every gate in this file reports green.
 *
 * The concrete case that prompted it: a 402-trade sample with +2.2% per trade and
 * a 59.7% win rate, whose worst peak-to-trough fall was 86.3%. That model is a
 * coin flip wearing a good average. Promoted on expectancy alone it would have
 * been allowed to trade unattended, and it would have been correct about the
 * average and catastrophic in practice.
 *
 * So promotion now requires the *path* to be survivable, not just the average to
 * be good. Three independent measures, because each catches something the others
 * miss:
 *
 *   maxDrawdown — the deepest fall from a peak. Catches the ruinous tail.
 *   profitFactor — gross wins over gross losses. Catches a strategy whose edge
 *     comes entirely from a few outsized wins against a stream of small losses,
 *     which averages well and dies of variance.
 *   tradeCadence — median gap between losing trades. Catches a model whose
 *     losses cluster, so the account is fine on average and empty after one bad
 *     week.
 */

/**
 * Peak-to-trough fall, as a positive fraction.
 *
 * Computed on the equity curve implied by the return sequence. Uses a running
 * peak rather than the final total, because a strategy that ends up ahead after
 * an 80% dip did not experience an 80% dip "recovered" — it experienced an 80%
 * dip and then had to earn all of it back.
 */
export function maxDrawdown(returns) {
  if (!Array.isArray(returns) || returns.length < 2) return 0;
  let equity = 1;
  let peak = 1;
  let worst = 0;
  for (const r of returns) {
    if (!Number.isFinite(r)) continue;
    equity *= 1 + r;
    if (equity > peak) peak = equity;
    // The fall is measured from the peak, not from 1, so a strategy that grew
    // first and then lost is penalised for losing from *its* high.
    if (peak > 0) worst = Math.max(worst, (peak - equity) / peak);
  }
  return Number(worst.toFixed(4));
}

/**
 * Gross wins over gross losses.
 *
 * `Infinity` when there are no losses at all — which is a real possibility in a
 * short sample and is handled as "passes this check" rather than crashing a sort.
 */
export function profitFactor(returns) {
  if (!Array.isArray(returns) || !returns.length) return 0;
  let wins = 0;
  let losses = 0;
  for (const r of returns) {
    if (!Number.isFinite(r)) continue;
    if (r > 0) wins += r;
    else losses += Math.abs(r);
  }
  if (losses === 0) return wins > 0 ? Infinity : 0;
  return Number((wins / losses).toFixed(3));
}

/**
 * Median gap, in trades, between consecutive losing trades.
 *
 * Clustering is the failure this catches. If losing trades come in runs, the
 * account absorbs them in one bad stretch rather than smoothly, and a risk limit
 * sized on the average says nothing about the stretch.
 */
export function lossCadence(returns) {
  if (!Array.isArray(returns) || !returns.length) return 0;
  const positions = [];
  returns.forEach((r, i) => {
    if (Number.isFinite(r) && r < 0) positions.push(i);
  });
  if (positions.length < 2) return positions.length === 1 ? returns.length : 0;
  const gaps = [];
  for (let i = 1; i < positions.length; i++) gaps.push(positions[i] - positions[i - 1]);
  gaps.sort((a, b) => a - b);
  const mid = gaps.length >> 1;
  return gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
}

/**
 * Every stability measure for a return sequence, or a reason it cannot be judged.
 *
 * Returns `null` rather than a permissive zero when the sample is too short to
 * say anything about its tail. A model with four trades has no measurable
 * drawdown, and reporting 0% for it would be the most dangerous possible answer.
 */
export function stability(returns) {
  const clean = (returns ?? []).filter((r) => Number.isFinite(r));
  if (clean.length < 10) return null;
  return {
    trades: clean.length,
    maxDrawdown: maxDrawdown(clean),
    profitFactor: profitFactor(clean),
    lossCadence: lossCadence(clean),
    worstTrade: Number(Math.min(...clean).toFixed(6)),
    bestTrade: Number(Math.max(...clean).toFixed(6)),
  };
}

/**
 * Would this record be safe to let trade unattended?
 *
 * Each limit is a separate, named reason rather than a single boolean, so a
 * refusal says what to fix. These thresholds are deliberately conservative and
 * are not tuned: a limit chosen by looking at which value let the best backtest
 * through is a limit that will let the next one through too.
 */
export function assessStability(returns, rules) {
  const s = stability(returns);
  if (!s) return { ok: false, stats: null, why: "not enough settled trades to judge the tail" };
  const problems = [];
  if (s.maxDrawdown > rules.maxDrawdown) {
    problems.push(`worst fall was ${(s.maxDrawdown * 100).toFixed(1)}%, over the ${(rules.maxDrawdown * 100).toFixed(0)}% limit`);
  }
  if (s.profitFactor < rules.minProfitFactor) {
    problems.push(`profit factor ${s.profitFactor} is under the ${rules.minProfitFactor} limit`);
  }
  if (s.lossCadence > 0 && s.lossCadence < rules.minLossCadence) {
    problems.push(`losing trades cluster — median ${s.lossCadence} trades apart, under the ${rules.minLossCadence} limit`);
  }
  return {
    ok: problems.length === 0,
    stats: s,
    why: problems.length ? problems.join("; ") : "loss profile is survivable",
  };
}
