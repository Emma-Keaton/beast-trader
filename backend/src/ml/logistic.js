/**
 * Direction model — L2-regularised logistic regression trained with
 * mini-batch gradient descent, implemented from scratch so the project keeps
 * its zero-dependency backend.
 *
 * Why logistic regression rather than a neural net for v2:
 *  - The reviews in this area (Wu et al. 2024 on deep learning for crypto;
 *    Qureshi et al. 2025 in PeerJ Comput. Sci.) are consistent on this: deep
 *    models do *not* reliably beat a well-specified linear baseline on
 *    crypto returns, and the impressive-looking accuracies are almost always
 *    in-sample or measured on price *levels* rather than returns. Capacity is
 *    not the bottleneck; data and validation are.
 *  - It is genuinely calibrated after Platt scaling, which is what the
 *    confidence number in the UI depends on. (A net's softmax scores are
 *    famously *not* probabilities.)
 *  - It is inspectable: `model.json` can be read by a human, which matters
 *    for something that suggests trades.
 *
 * Contract: `fit()` returns a serialisable model, `predictProbability()`
 * returns P(up) in 0..1. Feature standardisation is fitted on train data only
 * and stored in the model, so scoring is a pure function of the coefficients.
 */

import { FEATURE_NAMES } from "./features.js";

/** Column means/stds used to standardise features before the linear model. */
export function fitScaler(X) {
  const n = X.length;
  const d = X[0]?.length ?? FEATURE_NAMES.length;
  const mean = new Array(d).fill(0);
  // Accumulators start at zero: seeding them with 1 would leave a constant
  // column with std = sqrt(1/n) instead of 1 and skew every weight on it.
  const ss = new Array(d).fill(0);
  for (const row of X) for (let j = 0; j < d; j++) mean[j] += row[j];
  for (let j = 0; j < d; j++) mean[j] /= n || 1;
  for (const row of X) {
    for (let j = 0; j < d; j++) ss[j] += (row[j] - mean[j]) ** 2;
  }
  const std = new Array(d).fill(1);
  for (let j = 0; j < d; j++) {
    std[j] = Math.sqrt(ss[j] / (n || 1));
    // A constant column would otherwise divide by ~0 and explode.
    if (!(std[j] > 1e-8)) std[j] = 1;
  }
  return { mean, std };
}

export function applyScaler(scaler, row) {
  return row.map((v, j) => (v - scaler.mean[j]) / scaler.std[j]);
}

function sigmoid(z) {
  // Numerically stable: avoids overflow for |z| > ~700.
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

/**
 * Train the direction model.
 * @param X raw (unscaled) feature rows
 * @param y labels in {0,1} — 1 = price rose over the horizon
 * @param opts `{ epochs, lr, l2, batchSize, seed }`
 */
export function fit(X, y, opts = {}) {
  const { epochs = 400, lr = 0.1, l2 = 1e-3, batchSize = 64, seed = 42 } = opts;
  if (!X.length) throw new Error("fit: no training rows");
  const scaler = fitScaler(X);
  const xs = X.map((r) => applyScaler(scaler, r));
  const d = xs[0].length;
  const w = new Array(d).fill(0);
  let b = 0;

  // Deterministic shuffling — a fixed-seed LCG keeps runs reproducible so a
  // backtest result can be compared against the previous one honestly.
  const rand = mulberry32(seed);
  const order = xs.map((_, i) => i);

  for (let epoch = 0; epoch < epochs; epoch++) {
    shuffle(order, rand);
    for (let start = 0; start < order.length; start += batchSize) {
      const batch = order.slice(start, start + batchSize);
      const gw = new Array(d).fill(0);
      let gb = 0;
      for (const i of batch) {
        let z = b;
        for (let j = 0; j < d; j++) z += w[j] * xs[i][j];
        const p = sigmoid(z);
        const err = p - y[i];
        for (let j = 0; j < d; j++) gw[j] += err * xs[i][j];
        gb += err;
      }
      const m = batch.length || 1;
      for (let j = 0; j < d; j++) {
        // L2 pulls coefficients toward zero, which is what keeps a linear
        // model from memorising a noisy crypto series.
        w[j] -= lr * (gw[j] / m + l2 * w[j]);
      }
      b -= lr * (gb / m);
    }
  }

  // Platt calibration on the training set: fit a,b so that sigmoid(a*z+b)
  // matches observed frequency. Gives confidence numbers that mean something.
  const cal = fitPlatt(xs, y, w, b);
  return {
    kind: "logistic",
    version: 2,
    // Feature names must match the trained width exactly. Hard-coding the
    // base list here is what broke the 18-feature cross-sectional model: the
    // model carried 18 weights but advertised 12 names, so anything sized
    // from `model.features.length` read past the end of the row and produced
    // NaN. `fit` now derives the count from the data and only uses the caller's
    // names when they actually line up.
    features: namesFor(opts.featureNames, w.length),
    scaler,
    weights: w,
    bias: b,
    calib: cal,
  };
}

/**
 * Resolve the feature names stored on the model.
 *
 * - **Names claimed by the caller** are honoured only when they match the
 *   trained width exactly. A model that advertises names it does not have is
 *   precisely the bug that broke the 18-feature cross-sectional model:
 *   consumers sized their rows from `model.features.length` and read past the
 *   end of the vector. A mismatch therefore throws — it must never be papered
 *   over by substituting a different list after a console.warn nobody reads.
 * - **No names claimed** (`null`/`undefined`): the canonical base list when
 *   the width is exactly the base feature set, otherwise positional labels. A
 *   caller that claims nothing cannot be wrong about the labels — generic
 *   fits (walk-forward folds, test fixtures) legitimately train unlabeled
 *   widths through this branch, so it stays permissive by design.
 */
function namesFor(provided, width) {
  if (provided !== null && provided !== undefined) {
    if (!Array.isArray(provided) || provided.length !== width) {
      const got = Array.isArray(provided) ? `${provided.length} names` : typeof provided;
      throw new Error(
        `fit: got ${got} for a ${width}-feature model; refusing to store names that do not match the trained weights`,
      );
    }
    return provided;
  }
  return FEATURE_NAMES.length === width
    ? FEATURE_NAMES
    : Array.from({ length: width }, (_, i) => `f${i}`);
}
/**
 * Platt scaling: fit `a` and `c` so `sigmoid(a·z + c)` matches the observed
 * up/down frequency, which is what turns a raw score into a number we can
 * honestly show as a confidence percentage.
 *
 * Two details make this reliable rather than fragile:
 *  - the logits are standardised first, so `a` and `c` are on comparable
 *    scales and a fixed step size behaves;
 *  - the result is only accepted if it actually lowers log-loss versus the
 *    uncalibrated `sigmoid(z)`. A negative slope would silently invert every
 *    prediction, so that guard matters more than it looks.
 */
function fitPlatt(xs, y, w, b) {
  const n = y.length;
  if (!n) return { a: 1, c: 0 };

  const z = new Array(n);
  for (let i = 0; i < n; i++) {
    let s = b;
    for (let j = 0; j < w.length; j++) s += w[j] * xs[i][j];
    z[i] = s;
  }
  const mz = z.reduce((s, v) => s + v, 0) / n;
  const sz = Math.sqrt(z.reduce((s, v) => s + (v - mz) ** 2, 0) / n) || 1;
  const zs = z.map((v) => (v - mz) / sz);

  const loss = (a, c) => {
    let L = 0;
    for (let i = 0; i < n; i++) {
      const p = Math.min(1 - 1e-9, Math.max(1e-9, sigmoid(a * zs[i] + c)));
      L += -(y[i] * Math.log(p) + (1 - y[i]) * Math.log(1 - p));
    }
    return L / n;
  };

  let a = 1;
  let c = 0;
  const lr = 0.5;
  for (let iter = 0; iter < 300; iter++) {
    let ga = 0;
    let gc = 0;
    for (let i = 0; i < n; i++) {
      const err = sigmoid(a * zs[i] + c) - y[i];
      ga += err * zs[i];
      gc += err;
    }
    const na = Math.max(1e-3, a - (lr * ga) / n); // slope must stay positive
    const nc = c - (lr * gc) / n;
    if (loss(na, nc) > loss(a, c)) {
      // Step overshot: halve it, and stop if it is no longer productive.
      const ha = Math.max(1e-3, a - (lr * 0.5 * ga) / n);
      const hc = c - (lr * 0.5 * gc) / n;
      if (loss(ha, hc) >= loss(a, c)) break;
      a = ha;
      c = hc;
      continue;
    }
    a = na;
    c = nc;
  }

  // Reject a calibration that made things worse, or that would flip ordering.
  if (!Number.isFinite(a) || !Number.isFinite(c) || loss(a, c) > loss(1, 0)) return { a: 1, c: 0 };
  return { a, c, zMean: mz, zStd: sz };
}

/** P(up) for one raw feature row. */
export function predictProbability(model, rawRow) {
  if (!model) return 0.5;
  const d = model.weights.length;
  // A row of the wrong width is a bug in the caller, not a data problem. Pad or
  // truncate rather than reading `undefined` and returning NaN, which would
  // read as a valid probability at exactly the wrong moment.
  const row = rawRow?.length === d ? rawRow : fitWidth(rawRow, d);
  const x = applyScaler(model.scaler, row);
  let z = model.bias;
  for (let j = 0; j < d; j++) z += model.weights[j] * x[j];
  const cal = model.calib || { a: 1, c: 0 };
  // Calibrators trained on standardised logits must standardise again at
  // scoring time; older artefacts without zMean/zStd use the raw logit.
  const zz = cal.zStd ? (z - cal.zMean) / cal.zStd : z;
  return clamp01(sigmoid(cal.a * zz + cal.c));
}

/** Coerce a feature row to exactly `d` finite values. */
function fitWidth(row, d) {
  const out = new Array(d);
  for (let j = 0; j < d; j++) {
    const v = row?.[j];
    out[j] = Number.isFinite(v) ? v : 0;
  }
  return out;
}

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

function shuffle(arr, rand) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

/** Small, fast, seedable PRNG. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
