import test from "node:test";
import assert from "node:assert/strict";
import { tradeStats } from "../src/ml/backtestXs.js";

/**
 * Regression tests for cross-sectional P&L aggregation.
 *
 * The bug these pin: trades from one timestamp are a *basket* of simultaneous
 * positions, not a sequence of bets. Compounding them in dataset row order
 * applied the book's full variance once per coin, so a perfectly flat strategy
 * reported roughly -82% total return and 88% drawdown. Any model evaluated
 * that way had its P&L and drawdown fictionally destroyed, which is exactly the
 * figure that made the training report look self-contradictory.
 */

/** Build `coins` simultaneous trades at each of `periods` timestamps. */
function basket(periods, coins, fn) {
  const out = [];
  for (let p = 0; p < periods; p++) {
    for (let c = 0; c < coins; c++) out.push({ net: fn(p, c), ts: p, symbol: `C${c}` });
  }
  return out;
}

test("a flat cross-sectional basket reports flat, not catastrophic", () => {
  // +50%/-50% alternating nets to exactly zero per timestamp, forever.
  const r = tradeStats(basket(3, 4, (p, c) => (c % 2 ? -0.5 : 0.5)));
  assert.ok(Math.abs(r.totalReturn) < 1e-12, `flat basket must be flat, got ${r.totalReturn}`);
  assert.ok(r.maxDrawdown < 1e-12, `flat basket must have no drawdown, got ${r.maxDrawdown}`);
  assert.equal(r.count, 12, "every trade is still counted");
  assert.equal(r.periods, 3, "equity advances once per timestamp, not once per coin");
});

test("simultaneous positions are not compounded one after another", () => {
  // Every timestamp loses 10% on the basket. Compounding per *trade* over 4
  // coins would report (0.9)^4 = -34%, compounding per timestamp reports -10%.
  const r = tradeStats(basket(1, 4, () => -0.1));
  assert.ok(
    Math.abs(r.totalReturn - -0.1) < 1e-12,
    `one bar of a -10% basket is -10%, not -34%. Got ${r.totalReturn}`,
  );
});

test("expectancy stays per-trade while the equity path stays per-timestamp", () => {
  const r = tradeStats(basket(2, 2, (p, c) => (c ? -0.5 : 1.0)));
  // Per trade: (1.0, -0.5, 1.0, -0.5) -> mean 0.25
  assert.ok(Math.abs(r.expectancy - 0.25) < 1e-12, `per-trade expectancy, got ${r.expectancy}`);
  // Per timestamp: (0.25, 0.25) -> 1.25^2 - 1 = 0.5625
  assert.ok(Math.abs(r.totalReturn - 0.5625) < 1e-12, `per-timestamp compounding, got ${r.totalReturn}`);
});

test("drawdown is measured along the chronological basket path", () => {
  // Basket: +50%, -50%, +10%  => 1.5 -> 0.75 -> 0.825. Peak-to-trough = 50%.
  const r = tradeStats(
    basket(3, 1, (p) => [0.5, -0.5, 0.1][p]),
  );
  assert.ok(Math.abs(r.maxDrawdown - 0.5) < 1e-9, `expected 50% drawdown, got ${r.maxDrawdown}`);
});

test("trades arriving out of chronological order are still ordered correctly", () => {
  const forward = tradeStats(basket(3, 1, (p) => [0.5, -0.5, 0.1][p]));
  const shuffled = tradeStats([...basket(3, 1, (p) => [0.5, -0.5, 0.1][p])].reverse());
  assert.ok(
    Math.abs(forward.maxDrawdown - shuffled.maxDrawdown) < 1e-12,
    "drawdown must not depend on the order rows happen to arrive in",
  );
});

test("empty input is handled without dividing by zero", () => {
  const r = tradeStats([]);
  assert.equal(r.count, 0);
  assert.equal(r.totalReturn, 0);
  assert.equal(r.maxDrawdown, 0);
  assert.equal(r.periods, 0);
});