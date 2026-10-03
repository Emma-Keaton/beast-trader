/**
 * Two ways a challenger can look good without being good.
 *
 * Both exist because a promotion decision is made from *one* number about *one*
 * model, and both are ways that number lies.
 *
 * **Recency.** A model is promoted on its whole track record. If it earned its
 * edge over 400 trades and has been losing for the last 60, the average still
 * looks fine and the app keeps sizing as though nothing changed. Stale edge is
 * worse than no edge, because it carries position size with it. So a challenger
 * must also be profitable over its *recent* window, not just overall.
 *
 * **Correlation.** The registry holds up to `maxChallengers` models, all trained
 * on the same settled calls. They are not four independent experiments — they are
 * one experiment sampled four times. Picking the best of four and treating it as
 * the survivor is a multiple-comparisons error, and it is exactly how a promotion
 * loop manufactures a confident loser. `effectiveTrials` converts the correlated
 * count into the number of genuinely distinct ideas tried, which is the honest
 * denominator for the deflated-Sharpe hurdle.
 */

/**
 * Slice a return series into a recent window.
 *
 * The last `fraction` of trades, always at least `minTrades` so a short record
 * cannot produce a "recent" window of one trade that either passes or fails
 * arbitrarily.
 */
export function recentWindow(returns, { fraction = 0.4, minTrades = 15 } = {}) {
  if (!Array.isArray(returns) || !returns.length) return [];
  const take = Math.max(minTrades, Math.ceil(returns.length * fraction));
  // A record shorter than the minimum is returned whole rather than truncated to
  // nothing: on a 20-trade record, all 20 *are* the recent window.
  return returns.length <= take ? [...returns] : returns.slice(-take);
}

/**
 * Is the model still working, or did it stop?
 *
 * Compares recent expectancy against the full-record expectancy. A model whose
 * recent performance has collapsed relative to its own history is in decay, and
 * decay is invisible in the average.
 */
export function recencyVerdict(returns, { minRatio = 0, fraction = 0.4, minTrades = 15 } = {}) {
  const all = (returns ?? []).filter(Number.isFinite);
  if (all.length < minTrades * 2) {
    // Not enough history to distinguish "in decay" from "still ramping up". The
    // existing sample-size gates cover this case; claiming decay here would
    // refuse every young model for a reason that is really just youth.
    return { ok: true, why: "not enough history to judge recency", recent: null };
  }
  const recent = recentWindow(all, { fraction, minTrades });
  const overall = all.reduce((s, r) => s + r, 0) / all.length;
  const recentExp = recent.reduce((s, r) => s + r, 0) / recent.length;
  // Ratio against the overall expectancy, guarded when the overall is ~zero: a
  // ratio to a near-zero baseline is noise, not a signal.
  const ratio = Math.abs(overall) < 1e-9 ? null : recentExp / overall;
  const ok = recentExp > minRatio && (ratio === null || ratio >= 0);
  return {
    ok,
    why: ok
      ? `recent ${recent.length} trades average ${(recentExp * 100).toFixed(3)}%`
      : `recent ${recent.length} trades average ${(recentExp * 100).toFixed(3)}%, below the ${(minRatio * 100).toFixed(2)}% floor`,
    recent: { trades: recent.length, expectancy: Number(recentExp.toFixed(6)), overall: Number(overall.toFixed(6)), ratio: ratio === null ? null : Number(ratio.toFixed(3)) },
  };
}

/**
 * The honest number of independent experiments behind a set of challengers.
 *
 * Each challenger was fitted to the same settled calls, so their return streams
 * are correlated by construction. `effectiveTrials` uses the mean pairwise
 * correlation to collapse them toward the number of genuinely distinct ideas. A
 * set of four near-identical models is roughly one trial, and should be judged as
 * though one thing was tried.
 *
 * Returns the count alongside the correlation that produced it, because a reader
 * deserves to know whether "4 challengers" meant four ideas or one.
 */
export function correlationAdjustedTrials(challengers) {
  const series = (challengers ?? [])
    .map((c) => c?.trackRecord?.returns)
    .filter((r) => Array.isArray(r) && r.length >= 5);
  if (series.length < 2) return { trials: series.length, from: series.length, meanCorrelation: 0 };
  // Align lengths so returns from different-sized records line up positionally.
  const len = Math.min(...series.map((s) => s.length));
  const aligned = series.map((s) => s.slice(-len));
  const pairs = [];
  for (let i = 0; i < aligned.length; i++) {
    for (let j = i + 1; j < aligned.length; j++) {
      const a = aligned[i];
      const b = aligned[j];
      const ma = a.reduce((s, v) => s + v, 0) / a.length;
      const mb = b.reduce((s, v) => s + v, 0) / b.length;
      let num = 0;
      let da = 0;
      let db = 0;
      for (let k = 0; k < a.length; k++) {
        const x = a[k] - ma;
        const y = b[k] - mb;
        num += x * y;
        da += x * x;
        db += y * y;
      }
      const den = Math.sqrt(da * db);
      if (den > 0) pairs.push(num / den);
    }
  }
  if (!pairs.length) return { trials: aligned.length, from: aligned.length, meanCorrelation: 0 };
  const meanCorrelation = pairs.reduce((s, v) => s + v, 0) / pairs.length;
  // Same formula as `effectiveTrials`: correlated trials collapse toward 1.
  const trials = Math.max(1, Math.ceil(meanCorrelation + (1 - meanCorrelation) * aligned.length));
  return {
    trials,
    from: aligned.length,
    meanCorrelation: Number(meanCorrelation.toFixed(3)),
  };
}
