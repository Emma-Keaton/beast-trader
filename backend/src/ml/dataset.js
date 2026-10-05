/**
 * Labelling + evaluation for the direction model.
 *
 * A row's label is the sign of the return over the next `horizon` bars, but
 * only rows whose move is larger than a noise floor are kept: if the forward
 * move is smaller than typical bar-to-bar volatility, the "correct" answer is
 * undecidable and training on it just injects label noise. Dropping those
 * rows is what lets a 55%-accuracy model still be worth trading.
 */

import { buildFeatures } from "./features.js";
import { buildCrossSectional } from "./xsfeatures.js";
import { DEX_FEATURE_NAMES, dexValuesFor } from "./dexfeatures.js";

/**
 * Build supervised rows from OHLCV bars.
 * @returns `{ X, y, indices, meta }` — indices map each row back to its bar.
 */
export function buildDataset(bars, opts = {}) {
  const { horizon = 3, noiseMult = 0.5 } = opts;
  const { features, indices } = buildFeatures(bars);
  const X = [];
  const y = [];
  const kept = [];

  for (let k = 0; k < features.length; k++) {
    const i = indices[k];
    const exit = i + horizon;
    if (exit >= bars.length) break; // no future data — never label the tail

    const entry = bars[i].c;
    const fwdRet = bars[exit].c / entry - 1;
    const noise = typicalBarMove(bars, i);
    if (Math.abs(fwdRet) < noise * noiseMult) continue; // undecidable

    X.push(features[k]);
    y.push(fwdRet > 0 ? 1 : 0);
    kept.push(i);
  }
  return { X, y, indices: kept, meta: { horizon, noiseMult, rows: X.length } };
}

/**
 * Build the cross-sectional training set for the whole universe at once.
 *
 * Two changes from the single-coin `buildDataset` above, both aimed at the
 * same problem — the model was learning the market's direction rather than a
 * coin's relative strength:
 *
 *  1. **Market-relative labels.** A coin that rose 3% on a day the market rose
 *     4% is a *laggard*, and the label now says so. Under the old labelling it
 *     counted as a correct "up" prediction, which is how a model ends up with a
 *     high hit rate and no money.
 *
 *  2. **Volatility-scaled target.** The label is the forward return divided by
 *     the coin's own recent volatility, so a 3% move means the same thing for a
 *     coin that typically moves 1% as for one that typically moves 10%. Without
 *     this, high-volatility coins dominate the loss and the model is tuned
 *     mostly to them.
 *
 * Rows are emitted in timestamp order, so the purged cross-validation splits
 * stay contiguous in time.
 *
 * When `dexIndex` is supplied (see `dexfeatures.js`), two DEX columns are
 * appended per row and `meta.dexCoverage` reports the fraction of rows an
 * observation actually described. Above `minDexCoverage` the columns survive;
 * below it they are stripped again and `meta.dexIncluded` is false, so callers
 * size their feature-name lists from `meta` rather than assuming. With no
 * index the layout is exactly the 18 base+xs columns it always was.
 */
export function buildUniverseDataset(universe, opts = {}) {
  const { horizon = 3, noiseMult = 0.5, minCross = 5, dexIndex = null, minDexCoverage = 0.25 } = opts;
  const { rows } = buildCrossSectional(universe, { minCross });
  if (!rows.length) return { X: [], y: [], indices: [], meta: { horizon, rows: 0, coins: universe.length } };

  const bySymbol = new Map(universe.map(({ symbol, bars }) => [symbol, bars]));

  const X = [];
  const y = [];
  // The realised forward return for each row, so a backtest can compute
  // real money P&L instead of inferring it from the direction label.
  const fwd = [];
  const kept = [];
  let skippedUndecidable = 0;
  let dexObserved = 0; // rows whose DEX state was actually observed

  for (const row of rows) {
    const bars = bySymbol.get(row.symbol);
    if (!bars) continue;
    const exit = row.index + horizon;
    if (exit >= bars.length) continue; // no future data — never label the tail

    const entry = bars[row.index].c;
    const fwdRet = Math.log(bars[exit].c / entry);
    // Realised volatility over the window the label spans, scaled by
    // sqrt(horizon) so the ratio compares like with like.
    const vol = realisedVol(bars, row.index, horizon);
    const scaled = vol > 0 ? fwdRet / (vol * Math.sqrt(horizon)) : 0;

    if (Math.abs(fwdRet) < typicalBarMove(bars, row.index) * noiseMult) {
      skippedUndecidable++;
      continue; // the "right" answer here is genuinely undecidable
    }

    // DEX columns are appended when an index was supplied; the coverage policy
    // below decides whether they survive into the returned set.
    if (dexIndex) {
      const dex = dexValuesFor(dexIndex, row.symbol, row.ts);
      X.push([...row.base, ...row.xs, ...dex.values]);
      if (dex.observed) dexObserved++;
    } else {
      X.push([...row.base, ...row.xs]);
    }
    y.push(scaled > 0 ? 1 : 0);
    fwd.push(fwdRet);
    // The realised forward return is kept so the caller can simulate the
    // actual P&L of a prediction, rather than only scoring its direction.
    kept.push({ ts: row.ts, symbol: row.symbol, index: row.index, fwdRet });
  }

  // Coverage decides whether the DEX columns exist at all. A set that is 5%
  // observed would be 95% neutral padding: the scaler would learn almost
  // nothing from those columns and every future row would carry a near-constant
  // the model was trained to ignore. Below the floor the appended columns are
  // stripped again, so the model file, the walk-forward evaluation and live
  // scoring can never disagree about the row width — that disagreement is
  // exactly what broke the 18-feature model once already.
  const dexCoverage = X.length ? dexObserved / X.length : 0;
  const dexIncluded = Boolean(dexIndex) && X.length > 0 && dexCoverage >= minDexCoverage;
  if (dexIndex && !dexIncluded) {
    for (const r of X) r.length -= DEX_FEATURE_NAMES.length;
  }

  return {
    X,
    y,
    fwd,
    indices: kept,
    meta: {
      horizon,
      rows: X.length,
      skippedUndecidable,
      coins: universe.length,
      dexProvided: Boolean(dexIndex),
      dexIncluded,
      dexCoverage: Number(dexCoverage.toFixed(4)),
    },
  };
}

/**
 * Standard deviation of log returns over the `horizon` bars ending at `i`.
 * Taken from that window rather than a longer lookback so the scaling reflects
 * the volatility the label is actually measured against.
 */
export function realisedVol(bars, i, horizon) {
  const n = Math.max(2, horizon);
  const rets = [];
  for (let k = Math.max(1, i - n + 1); k <= i; k++) {
    if (bars[k - 1].c > 0) rets.push(Math.log(bars[k].c / bars[k - 1].c));
  }
  if (rets.length < 2) return 0;
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const varr = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length;
  return Math.sqrt(varr);
}

/** Median absolute bar return over a 20-bar window — the "noise" scale. */
export function typicalBarMove(bars, i, window = 20) {
  const start = Math.max(1, i - window + 1);
  const moves = [];
  for (let j = start; j <= i; j++) {
    if (bars[j - 1].c > 0) moves.push(Math.abs(bars[j].c / bars[j - 1].c - 1));
  }
  if (!moves.length) return 0;
  moves.sort((a, b) => a - b);
  return moves[Math.floor(moves.length / 2)];
}

/** Accuracy, precision, recall, F1 and Brier score for P(up) vs labels. */
export function classificationMetrics(probs, labels) {
  const threshold = 0.5;
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  let brier = 0;
  for (let i = 0; i < probs.length; i++) {
    const p = probs[i];
    brier += (p - labels[i]) ** 2;
    if (p >= threshold && labels[i] === 1) tp++;
    else if (p >= threshold && labels[i] === 0) fp++;
    else if (p < threshold && labels[i] === 0) tn++;
    else fn++;
  }
  const n = probs.length || 1;
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  return {
    samples: probs.length,
    accuracy: (tp + tn) / n,
    precision,
    recall,
    f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0,
    brier: brier / n,
    up_rate: labels.reduce((s, v) => s + v, 0) / n,
  };
}
