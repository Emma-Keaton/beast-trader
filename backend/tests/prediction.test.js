import test from "node:test";
import assert from "node:assert/strict";
import { predict, predictFromSeries, predictFromSnapshot } from "../src/services/predict.js";
import { synthBars } from "../src/ml/synth.js";
import { MODEL_FILE } from "../src/ml/registry.js";
import fs from "node:fs";

// ── rules tier (always available, no model required) ──────────────────────

test("a strong up day produces a buy", () => {
  const p = predictFromSnapshot({ price_usd: 100_000, change_24h: 9 });
  assert.equal(p.signal, "LONG");
  assert.equal(p.basis, "rules");
  assert.ok(p.confidence > 0.5);
  assert.ok(p.target_price > 100_000);
  assert.ok(p.stop_price < 100_000);
});

test("a strong down day produces a sell", () => {
  const p = predictFromSnapshot({ price_usd: 3000, change_24h: -12 });
  assert.equal(p.signal, "SHORT");
  assert.ok(p.target_price < 3000);
  assert.ok(p.stop_price > 3000);
});

test("a quiet day produces no trade", () => {
  const p = predictFromSnapshot({ price_usd: 100_000, change_24h: 0.2 });
  assert.equal(p.signal, "HOLD");
  assert.equal(p.target_price, null);
});

test("a thin-liquidity DEX coin is never traded, however good the move", () => {
  const p = predictFromSnapshot({
    price_usd: 1, change_24h: 40, liquidity_usd: 3_000, chain: "solana", dex: "raydium",
  });
  assert.equal(p.signal, "HOLD");
});

test("a deep-liquidity DEX coin can be traded", () => {
  const p = predictFromSnapshot({
    price_usd: 200, change_24h: 10, liquidity_usd: 4_000_000, chain: "solana", dex: "raydium",
  });
  assert.equal(p.signal, "LONG");
  assert.equal(p.model, "solana-v2");
});

test("every explanation is a readable sentence with no jargon", () => {
  const cases = [
    { price_usd: 100, change_24h: 9 },
    { price_usd: 100, change_24h: -9 },
    { price_usd: 100, change_24h: 0.1 },
    { price_usd: 1, change_24h: 20, liquidity_usd: 100, chain: "solana", dex: "d" },
  ];
  for (const c of cases) {
    const { reason } = predictFromSnapshot(c);
    assert.ok(typeof reason === "string" && reason.length > 10, `weak reason: ${reason}`);
    assert.ok(reason.endsWith("."), "explanations should be full sentences");
    for (const banned of ["oscillator", "RSI", "z-score", "logistic", "feature", "coefficient"]) {
      assert.ok(!reason.includes(banned), `explanation leaks jargon: ${banned}`);
    }
  }
});

test("the prediction contract always has every field the app relies on", () => {
  for (const p of [predictFromSnapshot({ price_usd: 100, change_24h: 5 }), predictFromSnapshot({})]) {
    for (const k of ["signal", "confidence", "target_price", "stop_price", "horizon", "reason", "model", "basis"]) {
      assert.ok(k in p, `missing field: ${k}`);
    }
    assert.ok(["LONG", "SHORT", "HOLD"].includes(p.signal));
    assert.ok(p.confidence >= 0 && p.confidence <= 1);
  }
});

// ── model tier ────────────────────────────────────────────────────────────

test("the model tier stays silent when no trained model is on disk", () => {
  if (fs.existsSync(MODEL_FILE)) return; // trained locally; covered by the model test below
  assert.equal(predictFromSeries(synthBars(200, { seed: 31 })), null);
});

test("the model tier refuses to score a series that is too short", () => {
  if (!fs.existsSync(MODEL_FILE)) return;
  assert.equal(predictFromSeries(synthBars(10, { seed: 32 })), null);
});

test("predict() always returns a usable prediction, whatever the inputs", () => {
  for (const snap of [
    { price_usd: 100, change_24h: 3 },
    { price_usd: 100, change_24h: 3, history: synthBars(200, { seed: 33 }) },
    { price_usd: 100, change_24h: 3, history: [] },
    {},
  ]) {
    const p = predict(snap);
    assert.ok(["LONG", "SHORT", "HOLD"].includes(p.signal));
    assert.ok(p.confidence >= 0 && p.confidence <= 1);
  }
});
