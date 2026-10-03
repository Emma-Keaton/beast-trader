import test from "node:test";
import assert from "node:assert/strict";
import { CircuitBreaker, setBreaker, STATE } from "../src/ml/circuit.js";
import { normaliseSymbol } from "../src/services/exchange.js";
import { checkPrerequisites, describeFailures, setTradingMode } from "../src/services/gate.js";
import { forecast, toPrediction } from "../src/ml/forecast.js";
import { resetBoard, recordSignal, settleCalls, board } from "../src/ml/scoreboard.js";
import { synthBars } from "../src/ml/synth.js";

/* ── Symbol normalisation ─────────────────────────────────────────────────── */

test("symbols are normalised to the unified BASE/QUOTE form", () => {
  assert.equal(normaliseSymbol("BTCUSDT"), "BTC/USDT");
  assert.equal(normaliseSymbol("BTC/USDT"), "BTC/USDT");
  assert.equal(normaliseSymbol("ethusd"), "ETH/USD");
  assert.equal(normaliseSymbol("SOL-USDC"), "SOL/USDC");
});

test("an unrecognisable symbol is refused rather than guessed", () => {
  // Guessing here would place an order on the wrong pair. Null is the only safe
  // answer when the quote currency cannot be determined.
  assert.equal(normaliseSymbol("BTCXYZ"), null);
  assert.equal(normaliseSymbol(""), null);
  assert.equal(normaliseSymbol(null), null);
  assert.equal(normaliseSymbol("USDT"), null, "a quote with no base is not a pair");
});

/* ── Circuit breaker ──────────────────────────────────────────────────────── */

test("the breaker allows trading by default", () => {
  const b = new CircuitBreaker();
  assert.equal(b.canTrade(), true);
  assert.equal(b.state, STATE.CLOSED);
});

test("a drawdown past the limit halts trading", () => {
  const b = new CircuitBreaker({ maxDrawdown: 0.15 });
  b.updateEquity(1000);
  b.updateEquity(900); // -10%, a warning
  assert.equal(b.canTrade(), true);
  b.updateEquity(840); // -16%, over the limit
  assert.equal(b.canTrade(), false);
  assert.match(b.reason, /equity fell 16/);
});

test("the drawdown is measured from the high-water mark, not the last value", () => {
  const b = new CircuitBreaker({ maxDrawdown: 0.15 });
  b.updateEquity(1000);
  b.updateEquity(1200); // new peak
  b.updateEquity(1190); // only -0.8% from the peak
  assert.equal(b.canTrade(), true, "a small fall from a higher peak is not a drawdown alarm");
});

test("a run of losing trades trips the breaker, and a win resets it", () => {
  const b = new CircuitBreaker({ maxConsecutiveLosses: 3 });
  b.recordTrade(-1);
  b.recordTrade(-1);
  assert.equal(b.canTrade(), true, "two losses is not yet a run");
  b.recordTrade(-1);
  assert.equal(b.canTrade(), false);
});

test("a win in the middle clears the losing streak", () => {
  const b = new CircuitBreaker({ maxConsecutiveLosses: 3 });
  b.recordTrade(-1);
  b.recordTrade(-1);
  b.recordTrade(1);
  b.recordTrade(-1);
  b.recordTrade(-1);
  assert.equal(b.canTrade(), true, "the streak restarted, so this is not a run of three");
});

test("stale price data halts trading", () => {
  const b = new CircuitBreaker({ maxStaleMs: 1000 });
  b.recordPrice(Date.now() - 60_000);
  b.evaluate("stale data");
  assert.equal(b.canTrade(), false);
  assert.match(b.reason, /data feed has stopped/);
});

test("resuming keeps the peak, so the same loss cannot immediately re-trip", () => {
  // The bug this guards: resetting the peak on resume would erase the drawdown
  // that caused the halt and let the identical loss happen again at once.
  const b = new CircuitBreaker({ maxDrawdown: 0.15 });
  b.updateEquity(1000);
  b.updateEquity(800);
  assert.equal(b.canTrade(), false);
  assert.equal(b.resume(), true);
  assert.equal(b.peak, 1000, "the high-water mark survives the resume");
  b.updateEquity(790);
  assert.equal(b.canTrade(), false, "the loss that caused the halt still trips it");
});

test("the breaker never resumes itself, even on good news", () => {
  // Resuming is a human decision. A halted bot that un-halts itself is a
  // runaway-loss machine that restarts on a timer.
  const b = new CircuitBreaker({ maxConsecutiveLosses: 1 });
  b.recordTrade(-1);
  assert.equal(b.canTrade(), false);
  b.updateEquity(1_000_000);
  assert.equal(b.canTrade(), false);
});

/* ── Trade gate ───────────────────────────────────────────────────────────── */

test("an order with no live mode is refused and says why", async () => {
  const r = await checkPrerequisites({
    deviceId: "gate-test-none",
    symbol: "BTCUSDT",
    side: "buy",
    notionalUsd: 50,
    intent: "live",
  });
  assert.equal(r.allowed, false);
  assert.ok(r.failures.some((f) => f.name === "live_mode"));
  assert.match(describeFailures(r), /live trading must be switched on/);
});

test("a malformed order fails the sanity checks", async () => {
  const r = await checkPrerequisites({
    deviceId: "gate-test-bad",
    symbol: "NOTAPAIR",
    side: "sideways",
    notionalUsd: -5,
    intent: "live",
  });
  assert.equal(r.allowed, false);
  const names = r.failures.map((f) => f.name);
  assert.ok(names.includes("valid_symbol"));
  assert.ok(names.includes("valid_side"));
  assert.ok(names.includes("valid_amount"));
});

test("the breaker blocks orders even when everything else is fine", async () => {
  // Manual orders must go through the kill switch too, or it has a hole in it.
  const breaker = new CircuitBreaker({ maxConsecutiveLosses: 1 });
  breaker.recordTrade(-1);
  setBreaker(breaker);
  try {
    const r = await checkPrerequisites({
      deviceId: "gate-test-breaker",
      symbol: "BTCUSDT",
      side: "buy",
      notionalUsd: 50,
      intent: "paper",
    });
    assert.equal(r.allowed, false);
    assert.ok(r.failures.some((f) => f.name === "circuit_breaker"));
  } finally {
    setBreaker(new CircuitBreaker());
  }
});

test("an unpromoted model is refused, and a manual trade is not", async () => {
  // The rule that stops an unproven model trading on its own. A human clicking
  // buy is a different decision and is not model-gated.
  const auto = await checkPrerequisites({
    deviceId: "gate-test-model",
    symbol: "BTCUSDT",
    side: "buy",
    notionalUsd: 50,
    intent: "live",
    modelBasis: "model",
  });
  assert.equal(auto.allowed, false);
  assert.ok(auto.failures.some((f) => f.name === "model_promoted"));

  const manual = await checkPrerequisites({
    deviceId: "gate-test-model",
    symbol: "BTCUSDT",
    side: "buy",
    notionalUsd: 50,
    intent: "live",
    modelBasis: "manual",
  });
  assert.ok(!manual.failures.some((f) => f.name === "model_promoted"));
});

test("paper orders skip the live-only checks entirely", async () => {
  const r = await checkPrerequisites({
    deviceId: "gate-test-paper",
    symbol: "BTCUSDT",
    side: "buy",
    notionalUsd: 50,
    intent: "paper",
  });
  assert.ok(!r.checks.some((c) => c.name === "live_mode"));
  assert.ok(!r.checks.some((c) => c.name === "model_promoted"));
});

test("order caps and the daily loss limit are enforced", async () => {
  const big = await checkPrerequisites({
    deviceId: "gate-test-caps",
    symbol: "BTCUSDT",
    side: "buy",
    notionalUsd: 10_000,
    intent: "live",
  });
  assert.ok(big.failures.some((f) => f.name === "order_cap"));

  const losing = await checkPrerequisites({
    deviceId: "gate-test-loss",
    symbol: "BTCUSDT",
    side: "buy",
    notionalUsd: 50,
    intent: "live",
    realisedLossTodayUsd: -60, // past the $50 daily limit
  });
  assert.ok(losing.failures.some((f) => f.name === "daily_loss_cap"));
});

test("switching to live is refused until every check passes", async () => {
  const r = await setTradingMode("gate-test-mode", "live");
  assert.equal(r.ok, false);
  assert.equal(r.readiness.ready, false);
  assert.ok(r.readiness.failures.length > 0);
});

test("switching back to paper is always allowed", async () => {
  // A user must never be locked out of reducing their own risk.
  const r = await setTradingMode("gate-test-mode", "paper");
  assert.equal(r.ok, true);
  assert.equal(r.mode, "paper");
});

test("an unknown mode is rejected", async () => {
  assert.equal((await setTradingMode("x", "yolo")).ok, false);
});

/* ── Forecasting ensemble ─────────────────────────────────────────────────── */

test("the ensemble refuses to forecast on too little history", () => {
  const f = forecast([1, 2, 3, 4, 5], { horizon: 3 });
  assert.equal(f.ok, false);
  assert.match(f.reason, /need at least/);
  assert.equal(toPrediction(f).signal, "HOLD", "no data means no trade");
});

test("the ensemble always returns a probability and a finite confidence", () => {
  const closes = synthBars(200, { seed: 7 }).map((b) => b.c);
  const f = forecast(closes, { horizon: 3 });
  assert.equal(f.ok, true);
  assert.ok(f.probUp > 0 && f.probUp < 1, "a probability, not a certainty");
  assert.ok(f.confidence >= 0 && f.confidence <= 1);
  assert.ok(f.models.length >= 2, "more than one model, or it is not an ensemble");
  assert.ok(f.models.some((m) => m.label === "drift"), "the null model is always present");
});

test("a flat series earns almost no confidence", () => {
  const f = forecast(new Array(100).fill(50), { horizon: 3 });
  assert.ok(Number.isFinite(f.probUp), "still returns a number");
  assert.ok(f.confidence < 0.2);
});

test("the ensemble's prediction carries no feature vector", () => {
  // It is a price-path forecaster, not a feature model. Claiming a feature
  // vector would let it be scored on the wrong basis in the ledger.
  const f = forecast(synthBars(200, { seed: 8 }).map((b) => b.c), { horizon: 3 });
  assert.equal(toPrediction(f).features, null);
  assert.equal(toPrediction(f).basis, "ensemble");
});
