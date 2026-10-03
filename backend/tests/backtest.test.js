import test from "node:test";
import assert from "node:assert/strict";
import { backtest, simulateTrade, tradeStats } from "../src/ml/backtest.js";
import { synthBars } from "../src/ml/synth.js";

const CFG = { horizon: 3, minConfidence: 0.55, feePct: 0.001, slippagePct: 0.0005, epochs: 80 };

test("backtest returns a well-formed report on synthetic data", () => {
  const r = backtest(synthBars(500, { seed: 21 }), { ...CFG, folds: 3 });
  assert.equal(r.ok, true);
  assert.ok(r.samples > 0);
  assert.ok(r.accuracy >= 0 && r.accuracy <= 1);
  assert.ok(r.brier >= 0 && r.brier <= 1);
  assert.equal(r.folds.length, 3);
});

test("backtest folds are strictly chronological (no future in training)", () => {
  const r = backtest(synthBars(500, { seed: 22 }), { ...CFG, folds: 4 });
  for (let i = 1; i < r.folds.length; i++) {
    assert.ok(
      r.folds[i].trainRows > r.folds[i - 1].trainRows,
      "each fold must train on strictly more history than the last",
    );
  }
});

test("backtest degrades gracefully on too little history", () => {
  const r = backtest(synthBars(20, { seed: 23 }), CFG);
  assert.equal(r.ok, false);
  assert.ok(r.reason);
});

test("backtest rejects a non-array input", () => {
  assert.equal(backtest(null, CFG).ok, false);
});

test("a genuinely learnable series beats a coin flip on Brier score", () => {
  // Strong regime trends with low noise: there is real structure to find.
  // 0.25 is the score of always answering 50/50, so beating it means the
  // walk-forward pipeline is extracting genuine information.
  const bars = synthBars(600, { seed: 24, drift: 0.004, vol: 0.004, regimeEvery: 30 });
  const r = backtest(bars, { ...CFG, folds: 3 });
  assert.ok(r.brier < 0.25, `brier ${r.brier} should beat the coin-flip baseline`);
  assert.ok(r.accuracy > 0.5, `accuracy ${r.accuracy} should beat a coin flip`);
});

test("on pure noise the model does not fake an edge", () => {
  // No drift at all means there is nothing to learn. A trustworthy pipeline
  // reports roughly coin-flip performance here rather than inventing a
  // spectacular win rate — this is the test that keeps the model honest.
  const bars = synthBars(600, { seed: 24, drift: 0, vol: 0.03, regimeEvery: 40 });
  const r = backtest(bars, { ...CFG, folds: 3 });
  assert.ok(r.brier < 0.31, `brier ${r.brier} should not blow up on noise`);
  assert.ok(r.accuracy < 0.75, `accuracy ${r.accuracy} on pure noise looks like overfitting`);
});

test("a confident LONG is charged fees on both sides and can still lose", () => {
  const bars = synthBars(50, { seed: 25, drift: -0.01, vol: 0.001 });
  const trade = simulateTrade(bars, 30, 0.9, CFG);
  assert.equal(trade.side, "LONG");
  assert.equal(trade.entryBar, 31);
  assert.equal(trade.exitBar, 33);
  // Costs are always deducted, even on a winning move.
  assert.ok(trade.netReturn < trade.grossReturn);
});

test("fees turn a tiny winning move into a net loss", () => {
  // Entry at bar 10, exit at bar 12: a +0.1% move that cannot survive the
  // 0.2% cost of a round trip. This is the test that keeps the backtest honest.
  const flat = Array.from({ length: 20 }, (_, i) => ({
    t: i, o: 100, h: 100.05, l: 99.95, c: 100, v: 1,
  }));
  flat[12].c = 100.1;
  const trade = simulateTrade(flat, 9, 0.9, { ...CFG, slippagePct: 0 });
  assert.ok(trade.grossReturn > 0, "the raw move should be a small win");
  assert.ok(trade.netReturn < 0, "round-trip fees must exceed a 0.1% move");
  assert.equal(trade.won, false);
});

test("low-confidence predictions place no trade at all", () => {
  const bars = synthBars(60, { seed: 26 });
  assert.equal(simulateTrade(bars, 30, 0.52, CFG), null);
  assert.equal(simulateTrade(bars, 30, 0.5, CFG), null);
  assert.ok(simulateTrade(bars, 30, 0.7, CFG));
  assert.ok(simulateTrade(bars, 30, 0.3, CFG));
});

test("no trade is left open past the end of the data", () => {
  const bars = synthBars(60, { seed: 27 });
  assert.equal(simulateTrade(bars, 58, 0.9, CFG), null);
  assert.equal(simulateTrade(bars, 57, 0.9, CFG), null);
});

test("tradeStats reports a consistent, bounded result set", () => {
  const trades = [
    { exitBar: 1, netReturn: 0.05, won: true, grossReturn: 0.06 },
    { exitBar: 2, netReturn: -0.02, won: false, grossReturn: -0.01 },
    { exitBar: 3, netReturn: 0.03, won: true, grossReturn: 0.04 },
  ];
  const s = tradeStats(trades);
  assert.equal(s.count, 3);
  assert.ok(Math.abs(s.winRate - 2 / 3) < 1e-9);
  assert.equal(s.profitFactor, 0.08 / 0.02);
  assert.ok(Math.abs(s.totalReturn - ((1.05 * 0.98 * 1.03) - 1)) < 1e-9);
  assert.ok(s.maxDrawdown >= 0 && s.maxDrawdown < 1);
});

test("tradeStats on an empty list is all zeros, not NaN", () => {
  const s = tradeStats([]);
  assert.equal(s.count, 0);
  for (const [k, v] of Object.entries(s)) {
    if (k !== "count") assert.equal(v, 0, `${k} should be 0, got ${v}`);
  }
});

test("wins followed by a crash register a drawdown", () => {
  const s = tradeStats([
    { exitBar: 1, netReturn: 0.5, won: true, grossReturn: 0.5 },
    { exitBar: 2, netReturn: -0.5, won: false, grossReturn: -0.5 },
  ]);
  assert.ok(s.maxDrawdown > 0.3, `expected a real drawdown, got ${s.maxDrawdown}`);
});
