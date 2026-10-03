import test from "node:test";
import assert from "node:assert/strict";
import {
  AUTO_CHAINS,
  CHAIN_PROFILES,
  allChainStatus,
  chainBreaker,
  profileFor,
  resetChainBreakers,
  screenCandidate,
} from "../src/ml/chains.js";
import { checkPrerequisites } from "../src/services/gate.js";
import { CircuitBreaker, setBreaker } from "../src/ml/circuit.js";

/* ── Per-chain profiles ───────────────────────────────────────────────────── */

test("every scanned chain has a profile with real limits", () => {
  for (const chain of AUTO_CHAINS) {
    const p = profileFor(chain);
    assert.ok(p, `${chain} has no profile`);
    assert.ok(p.minLiquidityUsd > 0, `${chain} has no liquidity floor`);
    assert.ok(p.maxNotionalUsd > 0);
    assert.ok(p.minConfidence > 0.5, `${chain} would trade on a coin flip`);
    assert.ok(p.minConfidence <= 1);
  }
});

test("an unknown chain falls back to a known profile", () => {
  assert.equal(profileFor("not-a-chain").kind, "cex");
  assert.equal(profileFor(undefined).label, CHAIN_PROFILES.cex.label);
});

test("DEX chains are held to a stricter bar than majors on a CEX", () => {
  // Venue risk, not model skill, sets this. Long-tail pools can be drained in
  // one transaction and there is no recourse afterwards.
  const dex = profileFor("solana");
  const cex = profileFor("cex");
  assert.ok(dex.minConfidence > cex.minConfidence, "DEX needs more confidence, not less");
  assert.ok(dex.maxNotionalUsd < cex.maxNotionalUsd, "smaller size on DEX");
});

/* ── Candidate screening ──────────────────────────────────────────────────── */

const goodSnap = { price_usd: 1.2, liquidity_usd: 2_000_000 };
const goodPred = { signal: "LONG", confidence: 0.9, probability: 0.8 };

test("a liquid, confident candidate passes", () => {
  const r = screenCandidate({ chain: "solana", snapshot: goodSnap, prediction: goodPred });
  assert.equal(r.ok, true, r.reasons?.join("; "));
});

test("a thin pool is refused however confident the model is", () => {
  // The critical case. Confidence measures direction; it says nothing about
  // whether the position can be exited. A $4k pool cannot be traded safely.
  const r = screenCandidate({
    chain: "solana",
    snapshot: { price_usd: 1.2, liquidity_usd: 4_000 },
    prediction: { ...goodPred, confidence: 0.99 },
  });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => /liquidity/.test(x)), r.reasons.join("; "));
});

test("missing liquidity is treated as unknown, not as fine", () => {
  // Absence of data must never read as permission.
  const r = screenCandidate({ chain: "solana", snapshot: { price_usd: 1.2 }, prediction: goodPred });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => /no liquidity figure/.test(x)));
});

test("a confident signal on a HOLD is still a HOLD", () => {
  const r = screenCandidate({
    chain: "cex",
    snapshot: goodSnap,
    prediction: { ...goodPred, signal: "HOLD" },
  });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => /no directional signal/.test(x)));
});

test("confidence below the chain's bar is refused", () => {
  const r = screenCandidate({
    chain: "solana",
    snapshot: goodSnap,
    prediction: { ...goodPred, confidence: 0.5 },
  });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => /confidence 50% is below the 75%/.test(x)));
});

test("a missing price is refused", () => {
  const r = screenCandidate({ chain: "cex", snapshot: { price_usd: 0, liquidity_usd: 1e6 }, prediction: goodPred });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => /no usable price/.test(x)));
});

/* ── Per-chain breakers ───────────────────────────────────────────────────── */

test("a halted chain does not halt the others", () => {
  // A Solana loss spiral says nothing about Ethereum. With one global breaker
  // the first chain to trip would stop everything, and the surviving chains
  // would stop earning evidence.
  resetChainBreakers();
  const sol = chainBreaker("solana");
  for (let i = 0; i < 4; i++) sol.recordTrade(-1); // past Solana's limit of 4
  assert.equal(chainBreaker("solana").canTrade(), false, "Solana is halted");
  assert.equal(chainBreaker("ethereum").canTrade(), true, "Ethereum is unaffected");
  assert.equal(chainBreaker("cex").canTrade(), true, "the CEX is unaffected");
  resetChainBreakers();
});

test("every chain reports its own status and limits", () => {
  resetChainBreakers();
  const s = allChainStatus();
  assert.equal(s.length, AUTO_CHAINS.length);
  for (const c of s) {
    assert.equal(typeof c.canTrade, "boolean");
    assert.ok(c.limits.minLiquidityUsd > 0, `${c.chain} must publish its liquidity floor`);
    assert.ok(c.limits.minConfidence > 0);
  }
});

/* ── The override cannot weaken the global breaker ────────────────────────── */

test("a chain override can stop trading but never re-enable it", async () => {
  // `breakerOverride` exists so one chain can be halted independently. If it
  // could also *un-halt* while the global breaker is open, that would be a
  // bypass of the app-wide kill switch.
  const global = new CircuitBreaker({ maxConsecutiveLosses: 1 });
  global.recordTrade(-1);
  setBreaker(global);
  try {
    const permissive = new CircuitBreaker(); // never tripped
    const r = await checkPrerequisites({
      deviceId: "override-test",
      symbol: "BTCUSDT",
      side: "buy",
      notionalUsd: 50,
      intent: "paper",
      breakerOverride: permissive,
    });
    assert.equal(r.allowed, false, "a healthy chain breaker must not override a halted global one");
    assert.ok(r.failures.some((f) => f.name === "circuit_breaker"));
  } finally {
    setBreaker(new CircuitBreaker());
  }
});

test("a halted chain breaker blocks its own orders", async () => {
  resetChainBreakers();
  const sol = chainBreaker("solana");
  for (let i = 0; i < 4; i++) sol.recordTrade(-1);
  const r = await checkPrerequisites({
    deviceId: "chain-block-test",
    symbol: "SOLUSDT",
    side: "buy",
    notionalUsd: 20,
    intent: "paper",
    breakerOverride: sol,
  });
  assert.equal(r.allowed, false);
  assert.ok(r.failures.some((f) => f.name === "circuit_breaker"));
  resetChainBreakers();
});

test("a chain's own cap is tighter than the global one", async () => {
  // A Solana position must not be able to consume the CEX budget. The chain
  // profile caps the plan, and the global cap is a second ceiling on top.
  assert.ok(profileFor("solana").maxNotionalUsd < profileFor("cex").maxNotionalUsd);
});
