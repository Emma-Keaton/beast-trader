import test from "node:test";
import assert from "node:assert/strict";
import { evaluate, breakevenWinRate, PROMOTION_BAR } from "../src/ml/evaluate.js";
import { openCall, settleMatured, paperStats } from "../src/ml/paper.js";
import { synthBars } from "../src/ml/synth.js";
import { backtest } from "../src/ml/backtest.js";

const GOOD = { accuracy: 0.62, brier: 0.21, expectancy: 0.004, trades: 400, deflated_sharpe: 0.98 };
// The measured result on real market data: no edge, and fees make it worse.
const WEAK = { accuracy: 0.499, brier: 0.274, expectancy: -0.0016, trades: 5601 };

// --- promotion gate ------------------------------------------------------

test("a genuinely good model is promoted", () => {
  const v = evaluate(GOOD);
  assert.equal(v.promoted, true);
  assert.deepEqual(v.reasons, []);
  assert.ok(v.headline.includes("passed"));
});

test("a coin-flip model is rejected, and the reason is stated plainly", () => {
  const v = evaluate(WEAK);
  assert.equal(v.promoted, false);
  assert.ok(v.reasons.length >= 2);
  assert.ok(v.reasons.some((r) => /fees|money/i.test(r)), "must explain it loses money");
  for (const r of v.reasons) assert.ok(r.endsWith("."), "reasons should be full sentences");
});

test("a model that only just clears accuracy is still blocked on profitability", () => {
  const v = evaluate({ ...GOOD, expectancy: 0 });
  assert.equal(v.promoted, false);
  assert.ok(v.reasons.some((r) => /money/i.test(r)));
});

test("a model whose edge could be luck is blocked even when it looks profitable", () => {
  // Profitable, accurate, calibrated — and still not trustworthy, because the
  // deflated Sharpe says the result may be the luckiest of many attempts.
  const v = evaluate({ ...GOOD, deflated_sharpe: 0.4 });
  assert.equal(v.promoted, false);
  assert.ok(v.reasons.some((r) => /luck/i.test(r)));
});

test("missing significance data is never treated as a pass", () => {
  const v = evaluate({ accuracy: 0.7, brier: 0.2, expectancy: 0.01, trades: 500 });
  assert.equal(v.promoted, false);
  assert.ok(v.reasons.some((r) => /luck/i.test(r)));
});

test("a profitable model with too few trades is held back", () => {
  const v = evaluate({ ...GOOD, trades: PROMOTION_BAR.minTrades - 1 });
  assert.equal(v.promoted, false);
  assert.ok(v.reasons.some((r) => /practice trades/i.test(r)));
});

test("the currently trained model is not trusted to trade on its own", () => {
  // The honest, measured outcome on real market data. If a future retrain
  // genuinely improves, this is the test to revisit — not quietly delete.
  assert.equal(evaluate(WEAK).promoted, false);
});

test("breakeven win rate reflects how lopsided wins and losses are", () => {
  // Win big, lose small: a low win rate can still break even.
  const easy = breakevenWinRate([
    { netReturn: 0.1 }, { netReturn: 0.1 }, { netReturn: -0.01 }, { netReturn: -0.01 },
  ]);
  // Win small, lose big: a 50% win rate still loses money.
  const rigged = breakevenWinRate([
    { netReturn: 0.01 }, { netReturn: 0.01 }, { netReturn: -0.1 }, { netReturn: -0.1 },
  ]);
  assert.ok(easy < rigged, `${easy} should be easier to beat than ${rigged}`);
});

test("breakeven on an empty trade list is zero, not NaN", () => {
  assert.equal(breakevenWinRate([]), 0);
});

test("a backtest on pure noise never passes the promotion gate", () => {
  const r = backtest(synthBars(600, { seed: 41, drift: 0, vol: 0.03, regimeEvery: 40 }), {
    horizon: 3, folds: 3, epochs: 120,
  });
  const v = evaluate({
    accuracy: r.accuracy, brier: r.brier, expectancy: r.trades.expectancy, trades: r.trades.count,
  });
  assert.equal(v.promoted, false);
});

// --- paper ledger -------------------------------------------------------

// A fresh device id per run. The ledger is persisted, so a fixed id made
// every test after the first see the previous run's settled calls and fail —
// the suite was only ever green the first time it was executed.
const DEV = `test-device-paper-${Date.now().toString(36)}`;

test("the paper ledger reports zeroes, not errors, before anything is tracked", async () => {
  const s = await paperStats(DEV);
  assert.equal(s.settled, 0);
  assert.equal(s.winRate, null);
  assert.equal(s.beatMarket, null);
  assert.equal(s.totalReturn, 0);
});

test("a HOLD prediction is never recorded as a trade", async () => {
  const row = await openCall(DEV, { symbol: "BTC", price_usd: 100 }, { signal: "HOLD", confidence: 0.9, model: "t" });
  assert.equal(row, null);
});

test("a prediction without a price is not recorded", async () => {
  const row = await openCall(DEV, { symbol: "BTC", price_usd: null }, { signal: "LONG", confidence: 0.9, model: "t" });
  assert.equal(row, null);
});

test("a real prediction is recorded as an open call with a due time", async () => {
  const row = await openCall(DEV, { symbol: "BTC", price_usd: 100 }, { signal: "LONG", confidence: 0.8, model: "t" });
  assert.equal(row.status, "open");
  assert.equal(row.side, "LONG");
  assert.ok(new Date(row.due_at) > new Date(), "a call must mature in the future");
});

test("a matured long that rose is scored as a win, net of fees", async () => {
  const row = await openCall(DEV, { symbol: "ETH", price_usd: 2000 }, { signal: "LONG", confidence: 0.8, model: "t" });
  row.due_at = new Date(Date.now() - 1000).toISOString(); // force maturity
  await settleMatured(DEV, async () => 2100); // +5%
  assert.equal(row.status, "settled");
  assert.equal(row.won, true);
  // +5% move, less the 0.2% round-trip fee.
  assert.ok(Math.abs(row.return_pct - 0.048) < 1e-6, `expected 4.8%, got ${row.return_pct}`);
});

test("a short that fell also counts as a win", async () => {
  const row = await openCall(DEV, { symbol: "SOL", price_usd: 100 }, { signal: "SHORT", confidence: 0.8, model: "t" });
  row.due_at = new Date(Date.now() - 1000).toISOString();
  await settleMatured(DEV, async () => 95); // -5%, a short profits
  assert.equal(row.won, true);
  assert.ok(row.return_pct > 0.04);
});

test("a losing long is scored as a loss", async () => {
  const row = await openCall(DEV, { symbol: "XRP", price_usd: 100 }, { signal: "LONG", confidence: 0.8, model: "t" });
  row.due_at = new Date(Date.now() - 1000).toISOString();
  await settleMatured(DEV, async () => 90);
  assert.equal(row.won, false);
  assert.ok(row.return_pct < 0);
});

test("the ledger compares against holding the coin, fees included on both sides", async () => {
  const row = await openCall(DEV, { symbol: "DOGE", price_usd: 100 }, { signal: "LONG", confidence: 0.8, model: "t" });
  row.due_at = new Date(Date.now() - 1000).toISOString();
  await settleMatured(DEV, async () => 103);
  // +3% minus 0.2% of fees, against a control charged the same 0.2% — so a
  // straight long is exactly on par, never a flattering "beat the market".
  assert.ok(Math.abs(row.return_pct - row.buy_hold_pct) < 1e-9);
  assert.ok(!row.beaten_market);
});

test("a winning short is credited with beating simply holding the coin", async () => {
  const row = await openCall(DEV, { symbol: "AVAX", price_usd: 100 }, { signal: "SHORT", confidence: 0.8, model: "t" });
  row.due_at = new Date(Date.now() - 1000).toISOString();
  await settleMatured(DEV, async () => 90); // price falls 10%
  // The short gains ~9.8% while holding the coin loses ~10.2%.
  assert.ok(row.return_pct > 0.09);
  assert.ok(row.buy_hold_pct < -0.1);
  assert.equal(row.beaten_market, true);
});

test("a call with no price available yet is left open for the next tick", async () => {
  const row = await openCall(DEV, { symbol: "ADA", price_usd: 100 }, { signal: "LONG", confidence: 0.8, model: "t" });
  row.due_at = new Date(Date.now() - 1000).toISOString();
  await settleMatured(DEV, async () => null);
  assert.equal(row.status, "open", "must not settle without a price");
});

test("stats summarise settled calls and still count the open ones", async () => {
  const s = await paperStats(DEV);
  assert.ok(s.settled >= 4);
  assert.ok(s.winRate >= 0 && s.winRate <= 1);
  assert.ok(s.beatMarket >= 0 && s.beatMarket <= 1);
  assert.ok(s.open >= 1, "the un-settled call should still be counted as open");
});
