/**
 * Feature engineering — turns a raw OHLCV price series into the numeric
 * feature vectors the models train on.
 *
 * Design principles:
 *  - **Only causal features.** Every value at index `t` is computed from bars
 *    at `t` and earlier. A bar at `t` closes at `t+1`, so a model predicting
 *    the next `horizon` bars can only ever see this data in a real poll.
 *  - **Scale-free.** Everything is a ratio, z-score or bounded oscillator, so
 *    a $100k BTC bar and a $0.00001 memecoin bar are directly comparable and
 *    one shared model works across all of them.
 *  - **Pure + deterministic.** No I/O, no Date.now(), no randomness. The same
 *    series always yields the same vectors, which is what makes the walk
 *    forward backtest reproducible.
 *
 * A "bar" is `{ t: epochMs, o, h, l, c, v }`.
 */

export const FEATURE_NAMES = [
  "ret_1", // last-bar return (momentum)
  "ret_3", // 3-bar momentum
  "ret_7", // 1-week-ish momentum
  "sma_gap_5", // price vs 5-bar SMA, normalised by price
  "sma_gap_20", // price vs 20-bar SMA (trend regime)
  "sma_slope", // SMA(5) slope, normalised — is the trend accelerating?
  "rsi_14", // momentum oscillator, mapped 0..1
  "vol_z", // volume vs its own 20-bar mean (participation)
  "range_pct", // intrabar range / close — volatility
  "vol_of_vol", // short-term vol vs long-term vol (regime shift)
  "close_pos", // where price sits in the recent range (0 low, 1 high)
  "drawdown", // distance from the running 20-bar high
];

const WARMUP = 21; // bars needed before the longest lookback (20) is satisfied

/** Rolling mean of the last `n` values ending at (and including) `end`. */
export function rollingMean(arr, end, n) {
  if (end + 1 < n) return null;
  let s = 0;
  for (let i = end - n + 1; i <= end; i++) s += arr[i];
  return s / n;
}

/** Rolling standard deviation (population) of the last `n` values. */
export function rollingStd(arr, end, n) {
  const mean = rollingMean(arr, end, n);
  if (mean == null) return null;
  let s = 0;
  for (let i = end - n + 1; i <= end; i++) s += (arr[i] - mean) ** 2;
  return Math.sqrt(s / n);
}

/** Wilder-style RSI over `n` bars, returned on a 0..1 scale. */
export function rsi(closes, end, n = 14) {
  if (end < n) return null;
  let gain = 0;
  let loss = 0;
  for (let i = end - n + 1; i <= end; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  if (loss === 0) return 1;
  const rs = gain / n / (loss / n);
  return rs / (1 + rs);
}

/**
 * Per-bar log returns, index-aligned with `closes`.
 * Index 0 has no prior bar, so it is defined as 0 rather than null — that
 * keeps every downstream rolling window a plain numeric pass with no
 * null-splicing, and 0 is the neutral value for a return.
 */
export function logReturns(closes) {
  const out = [0];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1];
    out.push(prev > 0 ? Math.log(closes[i] / prev) : 0);
  }
  return out;
}

/**
 * Build one feature vector per bar (nulls until WARMUP bars have elapsed).
 * Returns `{ features: number[][], indices: number[] }` where `indices[i]` is
 * the bar index that `features[i]` describes.
 */
export function buildFeatures(bars) {
  const closes = bars.map((b) => b.c);
  const vols = bars.map((b) => b.v || 0);
  const rets = logReturns(closes);

  // Short vs long realised volatility — both are one rolling pass over the
  // same return array, so this stays O(n) rather than slicing per bar.
  const volShort = [];
  const volLong = [];
  for (let i = 0; i < bars.length; i++) {
    volShort.push(rollingStd(rets, i, 5) ?? 0);
    volLong.push(rollingStd(rets, i, 20) ?? 0);
  }

  const features = [];
  const indices = [];
  let runningHigh = [];

  for (let i = 0; i < bars.length; i++) {
    if (i < WARMUP) {
      runningHigh.push(closes[i]);
      continue;
    }
    runningHigh.push(Math.max(runningHigh[i - 1], closes[i]));

    const p = closes[i];
    const sma5 = rollingMean(closes, i, 5);
    const sma20 = rollingMean(closes, i, 20);
    const prevSma5 = rollingMean(closes, i - 1, 5);
    const volMean20 = rollingMean(vols, i, 20) || 0;
    const volStd20 = rollingStd(vols, i, 20) || 0;
    const windowHigh = Math.max(...runningHigh.slice(Math.max(0, i - 19), i + 1));
    const windowLow = Math.min(...closes.slice(Math.max(0, i - 19), i + 1));

    features.push([
      safe(rets[i]),
      safe(closes[i] / closes[i - 3] - 1),
      safe(closes[i] / closes[i - 7] - 1),
      safe(sma5 / p - 1),
      safe(sma20 / p - 1),
      safe((sma5 - prevSma5) / p),
      safe(rsi(closes, i, 14) ?? 0.5),
      safe(volStd20 > 0 ? (vols[i] - volMean20) / volStd20 : 0),
      safe((bars[i].h - bars[i].l) / p),
      safe(volLong[i] > 0 ? volShort[i] / volLong[i] : 1),
      safe(windowHigh > windowLow ? (p - windowLow) / (windowHigh - windowLow) : 0.5),
      safe(p / runningHigh[i] - 1),
    ]);
    indices.push(i);
  }
  return { features, indices };
}

/** NaN/Inf guard: the models must never see a non-finite number. */
function safe(x) {
  return Number.isFinite(x) ? x : 0;
}

export { WARMUP };
