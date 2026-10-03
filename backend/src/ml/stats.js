// Euler–Mascheroni constant, to full double precision.
const EULER_MASCHERONI = 0.5772156649015329;

/**
 * Statistical inference for backtests, following López de Prado.
 *
 * Why this exists: a backtest reporting "52% accurate, profitable" is nearly
 * meaningless on its own. If you tried 50 variants and kept the best, 52% is
 * exactly what randomness produces. These functions answer the question that
 * actually matters — given everything we tried, how likely is this result to
 * be real? — in closed form, with no numerical stack and no dependencies.
 *
 * Implemented from the formulas in *Advances in Financial Machine Learning*,
 * cross-checked against `vectorbt/returns/metrics.py` and
 * `backtrader-cloudquant/.../sharpe_ratio_stats.py`.
 */

/**
 * Standard normal CDF (Abramowitz & Stegun 7.1.26).
 *
 * Accurate to ~1.5e-7, far beyond what a confidence figure needs. Note the
 * argument is divided by sqrt(2): the published approximation is for erf(x),
 * and Φ(z) = (1 + erf(z/√2)) / 2. Omitting that scaling inflates every
 * probability — Φ(1.96) would read 0.997 instead of 0.975, which is the
 * difference between "significant" and "not".
 */
export function normalCDF(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2;
  const p = 0.3275911;
  const t = 1 / (1 + p * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t *
      Math.exp(-ax * ax);
  return 0.5 * (1 + sign * y);
}

/**
 * Inverse normal CDF (Peter Acklam's rational approximation, ~1.15e-9).
 * Needed for the multiple-testing hurdle, which is a quantile.
 */
export function normalPPF(p) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;

  const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924];
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
  const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878];
  const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;

  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  if (p <= pHigh) {
    const q = p - 0.5;
    const r = q * q;
    return (
      ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
    );
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return (
    -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
    ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  );
}

/**
 * Sample moments of a return series.
 *
 * Kurtosis is the *Pearson* form (normal = 3), which is what the PSR
 * denominator expects. Mixing excess and Pearson kurtosis silently changes the
 * answer, so a flat series is normalised here rather than left to divide by
 * zero.
 */
export function returnMoments(returns) {
  const T = returns.length;
  if (T < 4) throw new Error("need at least 4 return samples");
  const mean = returns.reduce((s, r) => s + r, 0) / T;
  let m2 = 0;
  let m3 = 0;
  let m4 = 0;
  for (const r of returns) {
    const d = r - mean;
    m2 += d * d;
    m3 += d * d * d;
    m4 += d * d * d * d;
  }
  const variance = m2 / (T - 1);
  const std = Math.sqrt(variance);
  return {
    T,
    mean,
    std,
    variance,
    skewness: m2 > 0 ? (m3 / T) / Math.pow(m2 / T, 1.5) : 0,
    kurtosis: m2 > 0 ? (m4 / T) / Math.pow(m2 / T, 2) : 3,
    // Per-period (NOT annualised). Callers annualise if they want to.
    sharpe: std > 0 ? mean / std : 0,
  };
}

/**
 * Probabilistic Sharpe Ratio: P(true Sharpe > benchmark), corrected for
 * skew and fat tails. A raw Sharpe of 0.10 over 200 bars means much less
 * when the returns are lumpy than when they are smooth, and PSR captures
 * exactly that difference.
 */
export function probabilisticSharpeRatio(observedSR, benchmarkSR, T, skewness, kurtosis) {
  const denom = Math.sqrt(
    Math.max(1e-8, 1 - skewness * observedSR + ((kurtosis - 1) / 4) * observedSR * observedSR),
  );
  return normalCDF(((observedSR - benchmarkSR) * Math.sqrt(Math.max(T - 1, 0))) / denom);
}

/**
 * The Sharpe ratio the *best of N* random strategies would be expected to
 * reach by luck alone (Bailey & López de Prado).
 *
 * This is what makes a result honest: after 200 trials, a strategy has to
 * clear roughly this bar rather than zero.
 */
export function expectedMaxSharpe(varianceOfTrialSR, nTrials) {
  if (nTrials <= 1) return 0;
  const z1 = normalPPF(1 - 1 / nTrials);
  const z2 = normalPPF(1 - 1 / (nTrials * Math.E));
  return Math.sqrt(varianceOfTrialSR) * ((1 - EULER_MASCHERONI) * z1 + EULER_MASCHERONI * z2);
}

/**
 * Deflated Sharpe Ratio: the probability that the selected strategy's Sharpe
 * is genuinely positive, after accounting for both non-normality and the
 * number of configurations tried to find it.
 *
 * @param selectedSR  per-period Sharpe of the chosen strategy
 * @param trialSRs    per-period Sharpe of every configuration that was tried
 * @param T           number of return observations in the track record
 */
export function deflatedSharpeRatio(selectedSR, trialSRs, T, skewness, kurtosis) {
  const n = trialSRs.length;
  if (n <= 1) {
    return {
      dsr: probabilisticSharpeRatio(selectedSR, 0, T, skewness, kurtosis),
      expectedMaxSR: 0,
      nTrials: n,
    };
  }
  const mean = trialSRs.reduce((s, v) => s + v, 0) / n;
  const varTrials = trialSRs.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1);
  const hurdle = expectedMaxSharpe(varTrials, n);
  return {
    dsr: probabilisticSharpeRatio(selectedSR, hurdle, T, skewness, kurtosis),
    expectedMaxSR: hurdle,
    nTrials: n,
  };
}

/**
 * Effective number of independent trials.
 *
 * Counting configuration runs over-penalises: 200 hyperparameter searches are
 * not 200 independent experiments, they are a handful of ideas explored many
 * times. The average pairwise correlation between trial returns converts the
 * raw count into the number of *genuinely different* things tried, which is
 * the honest denominator for the hurdle above.
 */
export function effectiveTrials(returnsByTrial) {
  const n = returnsByTrial.length;
  if (n < 2) return n;
  const corrs = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const c = correlation(returnsByTrial[i], returnsByTrial[j]);
      if (Number.isFinite(c)) corrs.push(c);
    }
  }
  if (!corrs.length) return n;
  const meanCorr = corrs.reduce((s, v) => s + v, 0) / corrs.length;
  return Math.max(1, Math.ceil(meanCorr + (1 - meanCorr) * n));
}

/** Pearson correlation, guarded against zero-variance input. */
export function correlation(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const ma = a.slice(0, n).reduce((s, v) => s + v, 0) / n;
  const mb = b.slice(0, n).reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  const den = Math.sqrt(da * db);
  return den > 0 ? num / den : 0;
}
