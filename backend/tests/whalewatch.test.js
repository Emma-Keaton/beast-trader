/**
 * Whale flow collector tests.
 *
 * Same contract as dexwatch.test.js: the parsing half runs with no network
 * and no API key, because a Helius payload change must fail here — loudly —
 * rather than showing up as weeks of empty whale_flows rows that nobody
 * notices until a model quietly trains without them.
 *
 * The invariant every test below guards: nothing in this collector may ever
 * produce a row whose trade meaning is invented. Unpriced flows are dropped,
 * plain transfers keep `side: "unknown"`, and without a key the collector
 * makes zero network calls.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  parseWhaleFlows,
  collectOnce,
  fetchTokenPriceUsd,
  trackedMints,
  flowKey,
  whaleStatus,
  MIN_WHALE_USD,
} from "../src/services/whalewatch.js";
import { budgets as apiBudgets } from "../src/services/dexwatch.js";
import { LIMITS, resetBudgets } from "../src/ml/quota.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const TS = 1735689600; // 2025-01-01T00:00:00Z

/** A realistic large plain transfer (4000 SOL leaving a wallet). */
function sampleTransfer(over = {}) {
  return {
    signature: "SIG_TRANSFER_1",
    type: "TRANSFER",
    timestamp: TS,
    feePayer: "WHALE1",
    tokenTransfers: [
      { mint: SOL_MINT, fromUserOwner: "WHALE1", toUserOwner: "EXCHANGE1", tokenAmount: 4000 },
    ],
    ...over,
  };
}

/** A realistic whale swap: fee payer paying 300 SOL (a sell). */
function sampleSwap(over = {}) {
  return {
    signature: "SIG_SWAP_1",
    type: "SWAP",
    timestamp: TS,
    feePayer: "WHALE2",
    events: { swap: { nativeInput: { amount: "300000000" } } },
    tokenTransfers: [
      { mint: SOL_MINT, fromUserOwner: "WHALE2", toUserOwner: "POOL", tokenAmount: 300 },
    ],
    ...over,
  };
}

const PARSE = { mint: SOL_MINT, symbol: "SOL", priceUsd: 200 };

// ── parsing: transfers ─────────────────────────────────────────────────────

test("a large transfer parses into a flow row", () => {
  const rows = [parseWhaleFlows(sampleTransfer(), PARSE)];
  assert.equal(rows[0].length, 1);
  const row = rows[0][0];
  assert.equal(row.wallet, "WHALE1", "the mover is the wallet of record");
  assert.equal(row.side, "unknown", "a transfer says nothing about direction");
  assert.equal(row.symbol, "SOL");
  assert.equal(row.chain, "solana");
  assert.equal(row.amount_usd, 800_000);
  assert.equal(row.token_amount, 4000);
  assert.equal(row.tx_signature, "SIG_TRANSFER_1");
  assert.equal(row.ts, "2025-01-01T00:00:00.000Z");
  assert.ok(row.raw && row.raw.signature === "SIG_TRANSFER_1", "raw must survive for rebuilds");
});

test("the USD floor is inclusive and never bypassed", () => {
  // Exactly at the floor: 250 SOL x $200 = $50,000 → kept.
  const at = parseWhaleFlows(sampleTransfer({
    tokenTransfers: [{ mint: SOL_MINT, fromUserOwner: "W", toUserOwner: "X", tokenAmount: 250 }],
  }), PARSE);
  assert.equal(at.length, 1);
  assert.equal(at[0].amount_usd, MIN_WHALE_USD);

  // One dollar under: dropped. Ordinary wallet noise must never become a row.
  const under = parseWhaleFlows(sampleTransfer({
    tokenTransfers: [{ mint: SOL_MINT, fromUserOwner: "W", toUserOwner: "X", tokenAmount: 249.99 }],
  }), PARSE);
  assert.equal(under.length, 0);
});

// ── parsing: swaps ─────────────────────────────────────────────────────────

test("a swap is sided relative to its fee payer", () => {
  // Fee payer giving the tracked token → sell.
  const sell = parseWhaleFlows(sampleSwap(), PARSE);
  assert.equal(sell.length, 1);
  assert.equal(sell[0].side, "sell");
  assert.equal(sell[0].wallet, "WHALE2");
  assert.equal(sell[0].amount_usd, 60_000);

  // Fee payer receiving it → buy.
  const buy = parseWhaleFlows(sampleSwap({
    signature: "SIG_SWAP_2",
    tokenTransfers: [{ mint: SOL_MINT, fromUserOwner: "POOL", toUserOwner: "WHALE2", tokenAmount: 300 }],
  }), PARSE);
  assert.equal(buy[0].side, "buy");
  assert.equal(buy[0].wallet, "WHALE2");
});

test("a swap leg that touches the fee payer on neither side stays unknown", () => {
  // Pool-internal movement: claiming buy/sell would be invention, even inside
  // a swap transaction. The row is kept (the movement is real and large);
  // only the label is withheld.
  const rows = parseWhaleFlows(sampleSwap({
    tokenTransfers: [{ mint: SOL_MINT, fromUserOwner: "POOL_A", toUserOwner: "POOL_B", tokenAmount: 300 }],
  }), PARSE);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].side, "unknown");
});

test("swap detection does not depend on the type string alone", () => {
  // events.swap is the structured fact; type can be anything the parser maps
  // differently over time.
  const rows = parseWhaleFlows(sampleSwap({
    type: "UNKNOWN",
    events: { swap: {} },
  }), PARSE);
  assert.equal(rows[0].side, "sell", "events.swap alone must still mark it a swap");

  const noEvents = parseWhaleFlows(sampleSwap({ events: undefined }), PARSE);
  assert.equal(noEvents[0].side, "sell", "type SWAP alone must still mark it a swap");
});

// ── parsing: rejection ─────────────────────────────────────────────────────

test("an unpriced flow is never emitted", () => {
  // The invariant that makes the floor meaningful: a row with an unknown USD
  // size cannot be filtered by the threshold, and an unfiltered threshold is
  // no threshold at all.
  for (const priceUsd of [null, undefined, 0, -1, "abc", NaN]) {
    const rows = parseWhaleFlows(sampleTransfer(), { ...PARSE, priceUsd });
    assert.equal(rows.length, 0, `priceUsd=${priceUsd} must drop the row`);
  }
});

test("malformed transactions are dropped whole, not partially", () => {
  assert.deepEqual(parseWhaleFlows(null, PARSE), []);
  assert.deepEqual(parseWhaleFlows({}, PARSE), []);
  assert.deepEqual(parseWhaleFlows(sampleTransfer({ signature: "" }), PARSE), [], "no signature");
  assert.deepEqual(parseWhaleFlows(sampleTransfer({ timestamp: 0 }), PARSE), [], "no timestamp");
  assert.deepEqual(parseWhaleFlows(sampleTransfer({ tokenTransfers: undefined }), PARSE), [], "no transfers");
  assert.deepEqual(parseWhaleFlows(sampleTransfer(), { ...PARSE, mint: undefined }), [], "no mint to match");
});

test("other tokens' legs in the same transaction are ignored", () => {
  const rows = parseWhaleFlows(sampleTransfer({
    tokenTransfers: [
      { mint: "OTHER_MINT", fromUserOwner: "WHALE1", toUserOwner: "X", tokenAmount: 999_999 },
      { mint: SOL_MINT, fromUserOwner: "WHALE1", toUserOwner: "X", tokenAmount: 4000 },
    ],
  }), PARSE);
  assert.equal(rows.length, 1, "only the tracked mint becomes a row");
  assert.equal(rows[0].token_amount, 4000);
});

test("a payload without a UI amount falls back to the raw amount", () => {
  // Some Helius responses carry only rawTokenAmount. Without the fallback the
  // whole mint silently collects nothing.
  const rows = parseWhaleFlows(sampleTransfer({
    tokenTransfers: [{
      mint: SOL_MINT,
      fromUserOwner: "WHALE1",
      toUserOwner: "X",
      rawTokenAmount: { tokenAmount: "400000000000", decimals: 9 },
    }],
  }), PARSE);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].token_amount, 400);
  assert.equal(rows[0].amount_usd, 80_000);
});

test("flow keys distinguish sides and collapse repeats", () => {
  const a = parseWhaleFlows(sampleTransfer(), PARSE)[0];
  const b = parseWhaleFlows(sampleTransfer(), PARSE)[0];
  assert.equal(flowKey(a), flowKey(b), "the same tx parsed twice is the same flow");

  const sell = parseWhaleFlows(sampleSwap(), PARSE)[0];
  assert.notEqual(flowKey(a), flowKey(sell), "different sides are different flows");
});

// ── mint set ───────────────────────────────────────────────────────────────

test("tracked mints default to the shipped set and parse overrides", () => {
  const def = trackedMints("");
  assert.ok(def.SOL && def.USDC, "the shipped mints are the default");

  const over = trackedMints("BONK:mint-a,jup:mint-b");
  assert.deepEqual(Object.keys(over), ["BONK", "JUP"], "overrides parse and upper-case");
  assert.equal(over.JUP, "mint-b");

  assert.ok(trackedMints("garbage-no-colon").SOL, "an unusable override falls back to defaults");
  assert.ok(trackedMints("::").SOL, "empty override parts fall back to defaults");
});

test("stablecoins are priced at a dollar without spending a request", async () => {
  assert.equal(await fetchTokenPriceUsd(SOL_MINT, { symbol: "USDC" }), 1);
  assert.equal(await fetchTokenPriceUsd("AnyMint", { symbol: "USDT" }), 1);
});

// ── collection ─────────────────────────────────────────────────────────────

test("without a key the collector makes zero network calls", async () => {
  // The deployment contract: keyless runs the whole app unchanged. Any fetch,
  // price lookup or write attempted here means "disabled" is not actually
  // disabled.
  let touched = false;
  const res = await collectOnce({
    apiKey: "",
    mints: { SOL: SOL_MINT },
    fetchTxs: async () => { touched = true; return []; },
    priceFn: async () => { touched = true; return 200; },
    persist: async (rows) => { touched = true; return rows.length; },
    known: async () => new Set(),
  });
  assert.equal(res.enabled, false);
  assert.equal(touched, false, "disabled must mean untouched");
});

test("collectOnce stores new flows exactly once, across ticks and within a batch", async () => {
  const stored = [];
  const opts = {
    mints: { SOL: SOL_MINT },
    apiKey: "test-key",
    // The same signature twice in one response, as happens when a window
    // overlaps — it must still become one row.
    fetchTxs: async () => [sampleSwap(), sampleSwap()],
    priceFn: async () => 200,
    persist: async (rows) => { stored.push(...rows); return rows.length; },
    known: async () => new Set(),
  };

  const first = await collectOnce(opts);
  assert.equal(first.stored, 1, "duplicate signatures collapse within one tick");
  assert.equal(first.duplicates, 1);
  assert.equal(first.fetched, 2);

  // Second tick, with the first tick's output known: nothing is re-stored.
  const second = await collectOnce({
    ...opts,
    fetchTxs: async () => [sampleSwap()],
    known: async () => new Set(stored.map(flowKey)),
  });
  assert.equal(second.stored, 0, "already-known flows are never rewritten");
  assert.equal(second.duplicates, 1);
});

test("a failed provider response defers the mint instead of crashing the tick", async () => {
  const res = await collectOnce({
    mints: { SOL: SOL_MINT },
    apiKey: "test-key",
    fetchTxs: async () => null, // fetchJson's failure shape
    priceFn: async () => 200,
    persist: async (rows) => rows.length,
    known: async () => new Set(),
  });
  assert.equal(res.budget_denied, 1, "errors and rate limits both mean back off");
  assert.equal(res.stored, 0);
});

test("an exhausted rate window skips the mint without any network call", async () => {
  resetBudgets(apiBudgets);
  try {
    const cap = LIMITS.helius.standardPerSecond - 2; // the same headroom cap dexwatch uses
    for (let i = 0; i < cap; i++) assert.ok(apiBudgets.heliusStandard.take(), `slot ${i}`);

    let called = false;
    const res = await collectOnce({
      mints: { SOL: SOL_MINT },
      apiKey: "test-key",
      fetchTxs: async () => { called = true; return []; },
      priceFn: async () => 200,
      persist: async (rows) => rows.length,
      known: async () => new Set(),
    });
    assert.equal(res.budget_denied, 1, "budget exhaustion is counted, not thrown");
    assert.equal(called, false, "a spent budget must not be spent again");
  } finally {
    resetBudgets(apiBudgets);
  }
});

test("an unpriced mint skips its flows rather than storing them unsized", async () => {
  const res = await collectOnce({
    mints: { SOL: SOL_MINT },
    apiKey: "test-key",
    fetchTxs: async () => [sampleTransfer()],
    priceFn: async () => null, // price feed down
    persist: async (rows) => rows.length,
    known: async () => new Set(),
  });
  assert.equal(res.prices_unavailable, 1);
  assert.equal(res.stored, 0, "unsized flows must never reach the table");
});

test("status is honest about being observational only", () => {
  const s = whaleStatus();
  assert.equal(s.trade_trigger, false, "whale flows must never gate a trade");
  assert.equal(s.min_usd, MIN_WHALE_USD);
  assert.equal(s.table, "whale_flows");
  assert.ok(s.mints.includes("SOL"));
  assert.equal(typeof s.enabled, "boolean", "enabled is a plain flag");
});
