import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDexIndex,
  dexValuesFor,
  DEX_FEATURE_NAMES,
  DEX_NEUTRAL,
  REF_LAG_MS,
  MAX_SNAPSHOT_AGE_MS,
} from "../src/ml/dexfeatures.js";
import { buildUniverseDataset } from "../src/ml/dataset.js";
import { FEATURE_NAMES } from "../src/ml/features.js";
import { XS_FEATURE_NAMES } from "../src/ml/xsfeatures.js";
import { synthBars } from "../src/ml/synth.js";

/** synthBars' first bar timestamp — every bar is a day after this. */
const T0 = 1_700_000_000_000;

test("no index, unknown symbol, or no snapshot at/before the bar is neutral and unobserved", () => {
  const empty = buildDexIndex([]);
  const futureOnly = buildDexIndex([
    { symbol: "SOL", ts: T0 + 86_400_000, liquidity_usd: 1e6, buys: 5, sells: 5 },
  ]);
  const badTs = buildDexIndex([{ symbol: "SOL", ts: "not a date", liquidity_usd: 1e6 }]);

  for (const [idx, symbol, ts] of [
    [null, "SOL", T0],
    [empty, "SOL", T0],
    [futureOnly, "SOL", T0], // snapshot exists, but only AFTER the bar
    [badTs, "SOL", T0], // malformed timestamp never indexes
    [buildDexIndex([{ symbol: "SOL", ts: T0, liquidity_usd: 1e6 }]), "BTC", T0], // wrong symbol
    [buildDexIndex([{ symbol: "SOL", ts: T0, liquidity_usd: 1e6 }]), "SOL", "garbage"],
  ]) {
    const r = dexValuesFor(idx, symbol, ts);
    assert.deepEqual(r.values, DEX_NEUTRAL, "unobservable rows must be the neutral point");
    assert.equal(r.observed, false);
  }
});

test("a fresh snapshot is observed; trend is the 6h log-ratio and imbalance is signed", () => {
  const idx = buildDexIndex([
    { symbol: "SOL", ts: T0 - REF_LAG_MS, liquidity_usd: 100_000, buys: 30, sells: 10 },
    { symbol: "SOL", ts: T0, liquidity_usd: 110_000, buys: 30, sells: 10 },
  ]);
  const r = dexValuesFor(idx, "SOL", T0 + 60_000);
  assert.equal(r.observed, true);
  assert.ok(Math.abs(r.values[0] - Math.log(1.1)) < 1e-12, "trend must be log(ref -> now)");
  assert.ok(Math.abs(r.values[1] - 0.5) < 1e-12, "(30-10)/(30+10) = 0.5");
});

test("an observed row degrades its parts to neutral: no reference, no counts", () => {
  // One fresh snapshot: nothing 6h older to compare against, no txn counts.
  const idx = buildDexIndex([{ symbol: "SOL", ts: T0, liquidity_usd: 500_000 }]);
  const r = dexValuesFor(idx, "SOL", T0 + 1000);
  assert.equal(r.observed, true, "the snapshot itself IS current state");
  assert.deepEqual(r.values, [0, 0]);

  // Snapshot with counts but no usable liquidity numbers: imbalance survives.
  const idx2 = buildDexIndex([
    { symbol: "SOL", ts: T0 - REF_LAG_MS, buys: 1, sells: 1 },
    { symbol: "SOL", ts: T0, buys: 7, sells: 3 },
  ]);
  const r2 = dexValuesFor(idx2, "SOL", T0);
  assert.equal(r2.observed, true);
  assert.equal(r2.values[0], 0, "no liquidity figures -> no trend");
  assert.ok(Math.abs(r2.values[1] - 0.4) < 1e-12);
});

test("a stalled collector's stale snapshot is not treated as current state", () => {
  const idx = buildDexIndex([{ symbol: "SOL", ts: T0, liquidity_usd: 1e6, buys: 9, sells: 1 }]);
  const r = dexValuesFor(idx, "SOL", T0 + MAX_SNAPSHOT_AGE_MS + 1);
  assert.deepEqual(r.values, DEX_NEUTRAL);
  assert.equal(r.observed, false, "stale data must surface as unobserved, not as a confident feature");
});

test("ISO timestamps and unsorted input index correctly", () => {
  const idx = buildDexIndex([
    { symbol: "SOL", ts: new Date(T0).toISOString(), liquidity_usd: 100 },
    { symbol: "SOL", ts: new Date(T0 - 1000).toISOString(), liquidity_usd: 50 },
    { symbol: "", ts: T0 }, // never indexed
    { symbol: "SOL", ts: "nope" }, // never indexed
  ]);
  const list = idx.get("SOL");
  assert.equal(list.length, 2, "malformed rows are dropped, not fatal");
  assert.equal(list[0].ts, T0 - 1000, "records come out time-ordered");
  assert.equal(dexValuesFor(idx, "SOL", T0).observed, true);
});

// ── dataset width policy ─────────────────────────────────────────────────────

const BASE_W = FEATURE_NAMES.length + XS_FEATURE_NAMES.length;

test("dataset appends DEX columns when coverage clears the floor, and strips them when it does not", () => {
  const universe = ["AAA", "BBB"].map((symbol, i) => ({ symbol, bars: synthBars(300, { seed: 11 + i }) }));

  // Snapshots for every bar of every symbol -> full coverage.
  const full = [];
  for (const { symbol, bars } of universe) {
    for (const b of bars) full.push({ symbol, ts: b.t - 3_600_000, liquidity_usd: 1e6 + b.c, buys: 10, sells: 4 });
  }
  const covered = buildUniverseDataset(universe, {
    minCross: 2,
    dexIndex: buildDexIndex(full),
    minDexCoverage: 0.25,
  });
  assert.ok(covered.X.length > 0, "synthetic universe should produce rows");
  assert.equal(covered.meta.dexIncluded, true);
  assert.equal(covered.meta.dexCoverage, 1);
  for (const row of covered.X) assert.equal(row.length, BASE_W + DEX_FEATURE_NAMES.length);

  // Same snapshots, floor raised above what is available -> stripped to base+xs.
  const stripped = buildUniverseDataset(universe, {
    minCross: 2,
    dexIndex: buildDexIndex(full),
    minDexCoverage: 1.1,
  });
  assert.equal(stripped.meta.dexIncluded, false);
  for (const row of stripped.X) assert.equal(row.length, BASE_W);

  // No index at all -> the layout every existing test and model expects.
  const plain = buildUniverseDataset(universe, { minCross: 2 });
  assert.equal(plain.meta.dexProvided, false);
  assert.equal(plain.meta.dexIncluded, false);
  for (const row of plain.X) assert.equal(row.length, BASE_W);
});

test("coverage counts only rows an observation actually described", () => {
  const universe = ["AAA", "BBB"].map((symbol, i) => ({ symbol, bars: synthBars(300, { seed: 21 + i }) }));
  // Only AAA has snapshots -> roughly half the rows observed.
  const aaa = [];
  for (const { bars } of universe.filter((u) => u.symbol === "AAA")) {
    for (const b of bars) aaa.push({ symbol: "AAA", ts: b.t - 3_600_000, liquidity_usd: 1e6, buys: 5, sells: 5 });
  }
  const pool = buildUniverseDataset(universe, {
    minCross: 2,
    dexIndex: buildDexIndex(aaa),
    minDexCoverage: 0.25,
  });
  assert.ok(pool.X.length > 0);
  assert.ok(pool.meta.dexCoverage > 0.2 && pool.meta.dexCoverage < 0.8, `coverage ~0.5, got ${pool.meta.dexCoverage}`);
  assert.equal(pool.meta.dexIncluded, true, "half coverage clears a 0.25 floor");
});