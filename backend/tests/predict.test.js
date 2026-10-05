import test from "node:test";
import assert from "node:assert/strict";
import { fit, predictProbability, fitScaler, applyScaler } from "../src/ml/logistic.js";
import { buildFeatures, FEATURE_NAMES, WARMUP } from "../src/ml/features.js";
import { buildDataset, classificationMetrics } from "../src/ml/dataset.js";
import { synthBars } from "../src/ml/synth.js";

// â”€â”€ features â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

test("features produce one row per bar after the warmup period", () => {
  const bars = synthBars(120);
  const { features, indices } = buildFeatures(bars);
  assert.equal(features.length, bars.length - WARMUP);
  assert.equal(indices.length, features.length);
  assert.equal(features[0].length, FEATURE_NAMES.length);
});

test("features are always finite numbers", () => {
  const { features } = buildFeatures(synthBars(200, { seed: 3 }));
  for (const row of features) {
    assert.equal(row.length, FEATURE_NAMES.length);
    for (const v of row) assert.ok(Number.isFinite(v), `non-finite feature: ${v}`);
  }
});

test("features never look ahead (row t uses only bars <= t)", () => {
  // Mutating the final bars must not change the feature row for an earlier
  // bar. This is the single most important property in the pipeline: if it
  // breaks, every backtest number becomes fiction.
  const base = synthBars(150, { seed: 11 });
  const mutated = base.map((b) => ({ ...b }));
  for (let i = 100; i < mutated.length; i++) {
    mutated[i] = { ...mutated[i], c: mutated[i].c * 3, h: mutated[i].h * 3, l: mutated[i].l * 3, v: mutated[i].v * 5 };
  }
  const a = buildFeatures(base).features;
  const b = buildFeatures(mutated).features;
  const rowsBefore = 100 - WARMUP; // rows at bar indices < 100
  for (let i = 0; i < rowsBefore; i++) {
    for (let j = 0; j < FEATURE_NAMES.length; j++) {
      assert.ok(Math.abs(a[i][j] - b[i][j]) < 1e-12, `row ${i} feature ${FEATURE_NAMES[j]} leaked the future`);
    }
  }
});

test("constant-price series produces finite features (no NaN from 0/0)", () => {
  const flat = Array.from({ length: 60 }, (_, i) => ({
    t: i * 86_400_000, o: 10, h: 10, l: 10, c: 10, v: 100,
  }));
  const { features } = buildFeatures(flat);
  assert.ok(features.length > 0);
  for (const row of features) {
    for (const v of row) assert.ok(Number.isFinite(v));
  }
});

test("single-bar series yields no features rather than throwing", () => {
  const { features } = buildFeatures([{ t: 0, o: 1, h: 1, l: 1, c: 1, v: 1 }]);
  assert.equal(features.length, 0);
});

// â”€â”€ scaler â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

test("scaler standardises features to zero mean", () => {
  const { features } = buildFeatures(synthBars(200, { seed: 5 }));
  const scaler = fitScaler(features);
  const scaled = features.map((r) => applyScaler(scaler, r));
  for (let j = 0; j < FEATURE_NAMES.length; j++) {
    const mean = scaled.reduce((s, r) => s + r[j], 0) / scaled.length;
    assert.ok(Math.abs(mean) < 1e-9, `${FEATURE_NAMES[j]} mean ${mean}`);
  }
});

test("a constant feature column is left unscaled instead of exploding", () => {
  const scaler = fitScaler([[5, 1], [5, 2], [5, 3]]);
  assert.equal(scaler.std[0], 1);
  assert.deepEqual(applyScaler(scaler, [5, 1])[0], 0);
});

// â”€â”€ model training â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

test("a model learns a clearly separable pattern", () => {
  // Positive leading features => label 1. If the optimiser works, it should
  // learn this almost perfectly.
  const X = [];
  const y = [];
  for (let i = 0; i < 200; i++) {
    const v = i / 200 - 0.5;
    const row = new Array(FEATURE_NAMES.length).fill(0);
    row[0] = v;
    row[1] = v * 0.5;
    X.push(row);
    y.push(v > 0 ? 1 : 0);
  }
  const model = fit(X, y, { epochs: 600, lr: 0.5 });
  assert.ok(predictProbability(model, X[190]) > 0.9, "should be confident up on positive input");
  assert.ok(predictProbability(model, X[10]) < 0.1, "should be confident down on negative input");
});
test("fit refuses feature names that do not match the trained width", () => {
  // A model that advertises names it does not have is the bug that broke the
  // 18-feature cross-sectional model: consumers sized their rows from
  // model.features.length and read past the end of the vector. The mismatch
  // must throw, not quietly swap in a different list.
  const { X, y } = buildDataset(synthBars(200, { seed: 7 }), { horizon: 3 });
  assert.throws(
    () => fit(X, y, { epochs: 10, featureNames: ["only", "two"] }),
    /got 2 names for a 12-feature model/,
    "mismatched names should be rejected loudly",
  );
  // And names that DO line up are stored verbatim.
  const names = FEATURE_NAMES.map((n) => `renamed_${n}`);
  assert.deepEqual(fit(X, y, { epochs: 10, featureNames: names }).features, names);
  // With no names claimed, the canonical base list is attached at base width.
  assert.deepEqual(fit(X, y, { epochs: 10 }).features, FEATURE_NAMES);
});



test("predicted probability is always a valid probability", () => {
  const { X, y } = buildDataset(synthBars(400, { seed: 9 }), { horizon: 3 });
  const model = fit(X, y, { epochs: 60 });
  for (const row of X.slice(0, 50)) {
    const p = predictProbability(model, row);
    assert.ok(p >= 0 && p <= 1, `bad probability ${p}`);
  }
});

test("fit is deterministic for a fixed seed", () => {
  const { X, y } = buildDataset(synthBars(300, { seed: 4 }), { horizon: 3 });
  assert.deepEqual(fit(X, y, { epochs: 80, seed: 1 }).weights, fit(X, y, { epochs: 80, seed: 1 }).weights);
});

test("model weights and calibration are finite and correctly shaped", () => {
  const { X, y } = buildDataset(synthBars(300, { seed: 6 }), { horizon: 3 });
  const model = fit(X, y, { epochs: 50 });
  assert.equal(model.weights.length, FEATURE_NAMES.length);
  assert.equal(model.scaler.mean.length, FEATURE_NAMES.length);
  for (const w of model.weights) assert.ok(Number.isFinite(w));
  assert.ok(Number.isFinite(model.calib.a) && Number.isFinite(model.calib.c));
});

test("fit refuses empty training data instead of returning a broken model", () => {
  assert.throws(() => fit([], []), /no training rows/);
});

// â”€â”€ dataset â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

test("dataset labels match the actual forward move", () => {
  const bars = synthBars(300, { seed: 8 });
  const { X, y, indices, meta } = buildDataset(bars, { horizon: 3 });
  assert.ok(X.length > 20);
  assert.equal(X.length, y.length);
  assert.equal(meta.horizon, 3);
  // Spot-check the first row against the raw bars.
  const i = indices[0];
  assert.equal(y[0], bars[i + 3].c > bars[i].c ? 1 : 0);
});

test("a higher noise floor drops more undecidable rows", () => {
  const bars = synthBars(300, { seed: 12 });
  const loose = buildDataset(bars, { horizon: 3, noiseMult: 0 });
  const strict = buildDataset(bars, { horizon: 3, noiseMult: 5 });
  assert.ok(strict.X.length < loose.X.length);
});

test("dataset never emits a row whose future is unknown", () => {
  const bars = synthBars(200, { seed: 13 });
  const { indices } = buildDataset(bars, { horizon: 3 });
  for (const i of indices) assert.ok(i + 3 < bars.length);
});

test("classification metrics match a hand-computed example", () => {
  const m = classificationMetrics([0.9, 0.8, 0.2, 0.1], [1, 1, 0, 0]);
  assert.equal(m.accuracy, 1);
  assert.equal(m.precision, 1);
  assert.equal(m.recall, 1);
  assert.equal(m.samples, 4);
  // Confident and correct => Brier far below the 0.25 coin-flip score.
  assert.ok(m.brier < 0.25);
});

test("all-coin-flip predictions score 0.25 Brier, the known baseline", () => {
  const m = classificationMetrics([0.5, 0.5, 0.5, 0.5], [1, 0, 1, 0]);
  assert.equal(m.brier, 0.25);
  assert.equal(m.accuracy, 0.5);
});
