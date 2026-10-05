/**
 * DEX collector tests.
 *
 * The parsing half runs with no network and no API key, which is the point: a
 * DexScreener payload change should fail here, loudly, rather than showing up as
 * three days of empty rows in Supabase that nobody notices until a model
 * quietly trains on nothing.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  parsePair,
  parsePairsResponse,
  collectOnce,
  quotaStatus,
  budgets,
  rankAndFilter,
  DEFAULT_QUERIES,
  WATCH_CHAINS,
} from "../src/services/dexwatch.js";
import { LIMITS } from "../src/ml/quota.js";

/** A realistic DexScreener pair payload. */
function samplePair(over = {}) {
  return {
    chainId: "solana",
    dexId: "raydium",
    pairAddress: "PAIR123",
    baseToken: { address: "TOKEN123", symbol: "bonk" },
    priceUsd: "0.00001234",
    liquidity: { usd: "450000.50" },
    volume: { h24: "8200000" },
    priceChange: { m5: "1.2", h1: "-3.4", h24: "18.9" },
    txns: {
      m5: { buys: 10, sells: 4 },
      h1: { buys: 90, sells: 70 },
      h24: { buys: 900, sells: 800 },
    },
    ...over,
  };
}

// ── parsing ────────────────────────────────────────────────────────────────

test("a pair parses into the snapshot shape", () => {
  const p = parsePair(samplePair());
  assert.equal(p.symbol, "BONK");
  assert.equal(p.chain, "solana");
  assert.equal(p.address, "TOKEN123");
  assert.ok(Math.abs(p.price_usd - 0.00001234) < 1e-12, "string prices must become numbers");
  assert.ok(Math.abs(p.liquidity_usd - 450000.5) < 1e-9);
  assert.equal(p.price_change_1h, -3.4);
  assert.equal(p.source, "dexscreener");
});

test("buy and sell counts are summed across timeframes, not read from one", () => {
  const p = parsePair(samplePair());
  // 900 + 90 + 10
  assert.equal(p.buys, 1000);
  assert.equal(p.sells, 874);
  // The bug this pins: reading only h24 would give 900/800 and silently treat
  // a 5m burst as noise, which for a mover detector is exactly the signal.
  assert.notEqual(p.buys, 900);
});
test("an unusable pair is dropped rather than stored half-formed", () => {
  assert.equal(parsePair(null), null);
  assert.equal(parsePair({}), null, "no base token");
  assert.equal(parsePair({ baseToken: { address: "A" } }), null, "no price");
  assert.equal(parsePair({ baseToken: { address: "A" }, priceUsd: "0" }), null, "zero price");
  assert.equal(parsePair({ baseToken: { address: "A" }, priceUsd: "-1" }), null, "negative price");
  // This is the important one: a null price row would pass a `liquidity > 0`
  // style feature check while describing nothing at all.
  assert.equal(parsePair({ baseToken: { address: "A" }, priceUsd: "abc" }), null, "unparseable price");
});

test("a bad row in a good response does not take the batch down", () => {
  const rows = parsePairsResponse({
    pairs: [
      samplePair(),
      null,
      { junk: true },
      samplePair({ baseToken: { address: "T2", symbol: "wif" } }),
    ],
  });
  assert.equal(rows.length, 2, "one good row in, one good row out");
  assert.deepEqual(rows.map((r) => r.symbol), ["BONK", "WIF"]);
});

test("rows can be filtered by chain", () => {
  const json = {
    pairs: [samplePair(), samplePair({ chainId: "ethereum", baseToken: { address: "E", symbol: "eth" } })],
  };
  assert.equal(parsePairsResponse(json, { chains: ["solana"] }).length, 1);
  assert.equal(parsePairsResponse(json).length, 2);
});

test("a non-response is empty, not an exception", () => {
  assert.deepEqual(parsePairsResponse(null), []);
// ── budget behaviour ───────────────────────────────────────────────────────

test("the collector degrades to zero fetches once its budget is gone", async () => {
  const cap = LIMITS.dexscreener.pairsPerMinute - 20;
  // Drain the shared window the same way a real tick would.
  for (let i = 0; i < cap; i++) budgets.dexscreenerPairs.take(Date.now() + i);

  assert.equal(budgets.dexscreenerPairs.remaining(), 0);

  const before = budgets.dexscreenerPairs.used(Date.now() + cap);
  const result = await collectOnce({ chains: ["solana"], persist: async () => 0 });

  // Exhausted means DEGRADED (empty, reported honestly) — not a 429, and not a
  // throw. The point is that a thin history is acceptable and a ban is not.
  assert.equal(result.fetched, 0);
  assert.equal(result.stored, 0);
  assert.ok(result.budget_denied >= 1, "the tick must admit it was throttled");
  assert.equal(
    budgets.dexscreenerPairs.used(Date.now() + cap),
    before,
    "a denied call must not be counted against the budget",
  );
});

test("quotaStatus reports the throttle rather than hiding it", () => {
  const s = quotaStatus();
  assert.equal(s.dexscreener_pairs_limit, LIMITS.dexscreener.pairsPerMinute);
  assert.ok(typeof s.dexscreener_pairs_remaining === "number");
  assert.equal(s.credits.in_memory_only, true, "must disclose the count does not survive a restart");
});

// ── collectOnce contract ───────────────────────────────────────────────────

test("collectOnce reports zero rather than undefined when nothing is persisted", async () => {
  // No persist function: it must return the rows rather than throwing, so the
  // path is testable without a database.
  const result = await collectOnce({ chains: [], now: () => "2026-01-01T00:00:00.000Z" });
  assert.equal(result.fetched, 0);
  assert.equal(result.stored, 0, "nothing was persisted, so stored must be 0, not undefined");
});

test("solana is a chain we actually collect", () => {
  assert.ok(WATCH_CHAINS.includes("solana"), "the deployment target must be in the list");
});

// ── ranking ────────────────────────────────────────────────────────────────

test("thin pools are never recorded", () => {
  const rows = [
    { address: "A", liquidity_usd: 50, price_change_1h: 1 },
    { address: "B", liquidity_usd: 500_000, price_change_1h: 1 },
  ];
  const out = rankAndFilter(rows, { minLiquidityUsd: 100_000 });
  assert.equal(out.length, 1);
  assert.equal(out[0].address, "B", "a pool we could never trade must not become an observation");
});

test("one token with many pools is recorded once", () => {
  // Measured live: SOL returns ~20 pools for a single token. Recording all of
  // them would let one asset dominate the cross-section, which is the input a
  // rank-based feature is built on.
  const rows = [
    { address: "SOL", liquidity_usd: 900_000, price_change_1h: 1 },
    { address: "SOL", liquidity_usd: 800_000, price_change_1h: 2 },
    { address: "BONK", liquidity_usd: 700_000, price_change_1h: 3 },
  ];
  const out = rankAndFilter(rows, { minLiquidityUsd: 100_000 });
  assert.equal(out.length, 2);
  assert.equal(new Set(out.map((r) => r.address)).size, 2);
});

test("a row that reports price movement beats a deeper row that does not", () => {
  // This is the bug the live probe found. DexScreener returns no priceChange on
  // the deepest stable-quoted pools, so a pure depth sort fills the budget with
  // rows a feature cannot use — 0/10 usable, measured live.
  const rows = [
    { address: "DEEP_NO_CHANGE", liquidity_usd: 2_500_000_000, price_change_1h: null },
    { address: "SHALLOW_USEFUL", liquidity_usd: 300_000, price_change_1h: -0.83 },
  ];
  const out = rankAndFilter(rows, { minLiquidityUsd: 100_000 });
  assert.equal(out[0].address, "SHALLOW_USEFUL", "completeness must outrank depth");
});

test("liquidity still breaks ties within the same completeness", () => {
  const rows = [
    { address: "SHALLOW", liquidity_usd: 200_000, price_change_1h: 1 },
    { address: "DEEP", liquidity_usd: 900_000, price_change_1h: 1 },
  ];
  const out = rankAndFilter(rows, { minLiquidityUsd: 100_000 });
  assert.equal(out[0].address, "DEEP");
});

// ── discovery queries ──────────────────────────────────────────────────────

test("every chain's discovery queries are PAIR queries, not bare names", () => {
  // Measured: q=solana returned 21 pairs / 1 symbol / 0 usable, while
  // q=SOL/USDC returned 25 pairs / 9 symbols / all usable. A bare chain or token
  // name collapses the cross-section onto one asset.
  for (const [chain, queries] of Object.entries(DEFAULT_QUERIES)) {
    for (const q of queries) {
      assert.ok(
        q.includes("/"),
        `${chain} query "${q}" has no quote asset — it will match one token only`,
      );
    }
  }
});
  assert.deepEqual(parsePairsResponse({}), []);
  assert.deepEqual(parsePairsResponse({ pairs: "not-an-array" }), []);
});

test("the raw provider payload is retained for rebuilds", () => {
  const p = parsePair(samplePair());
  assert.ok(p.raw && p.raw.pairAddress === "PAIR123", "raw must survive so features can be re-derived");
});

test("a missing timeframe does not poison the counts with NaN", () => {
  const p = parsePair(samplePair({ txns: { h24: { buys: 5, sells: 5 } } }));
  assert.equal(p.buys, 5);
  assert.equal(p.sells, 5);
  assert.ok(Number.isFinite(p.buys), "sums must never be NaN");
});