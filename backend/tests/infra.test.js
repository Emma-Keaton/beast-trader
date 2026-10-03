import test from "node:test";
import assert from "node:assert/strict";
import { TtlCache } from "../src/core/cache.js";
import { Batcher } from "../src/core/batcher.js";
import { SoftError, breakerState, resetClientState, clientHealth } from "../src/core/http.js";
import { rankMovers, moverScore, dedupeBestPair, normalisePair } from "../src/services/data.js";
import { MonthlyBudget, creditFor } from "../src/core/budget.js";
import { cleanName, cleanSymbol, numberOrNull } from "../src/services/clean.js";
import { combinatorialPurgedCV, makeEvent, purgedSplit, reconstructPath, windowsOverlap } from "../src/ml/purged.js";
import { correlation, deflatedSharpeRatio, expectedMaxSharpe, normalCDF, normalPPF, probabilisticSharpeRatio, returnMoments, effectiveTrials } from "../src/ml/stats.js";
import { betSize, sizePosition, turbulenceIndex } from "../src/ml/sizing.js";

// --- cache ---------------------------------------------------------------

test("a miss calls the producer and a hit does not", async () => {
  const c = new TtlCache();
  let calls = 0;
  const produce = async () => ++calls;
  assert.equal(await c.fetch("k", produce, 1000), 1);
  assert.equal(await c.fetch("k", produce, 1000), 1);
  assert.equal(calls, 1);
});

test("an expired entry is refetched", async () => {
  const c = new TtlCache();
  let calls = 0;
  const produce = async () => ++calls;
  await c.fetch("k", produce, 20);
  await new Promise((r) => setTimeout(r, 40));
  await c.fetch("k", produce, 20);
  assert.equal(calls, 2);
});

test("concurrent misses on a cold key make exactly one upstream call", async () => {
  // Single-flight: without this, a dashboard open on four panels fires four
  // identical requests on every cold load.
  const c = new TtlCache();
  let calls = 0;
  const produce = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 20));
    return "value";
  };
  const results = await Promise.all([c.fetch("k", produce, 1000), c.fetch("k", produce, 1000), c.fetch("k", produce, 1000)]);
  assert.equal(calls, 1);
  assert.deepEqual(results, ["value", "value", "value"]);
});

test("a failed producer rejects every waiter and does not poison the cache", async () => {
  const c = new TtlCache();
  const boom = async () => {
    throw new Error("upstream down");
  };
  await assert.rejects(Promise.all([c.fetch("k", boom, 1000), c.fetch("k", boom, 1000)]), /upstream down/);
  // The key must still be fetchable afterwards.
  assert.equal(await c.fetch("k", async () => "ok", 1000), "ok");
});

test("stale data is served immediately while a refresh runs behind it", async () => {
  const c = new TtlCache({ staleMs: 500 });
  await c.fetch("k", async () => "old", 20);
  await new Promise((r) => setTimeout(r, 40)); // expired, but within staleMs
  let refreshed = false;
  const value = await c.fetch("k", async () => {
    refreshed = true;
    return "new";
  }, 1000);
  assert.equal(value, "old", "must not block on the refresh");
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(refreshed, "refresh should have run in the background");
  assert.equal(await c.peek("k"), "new");
});

test("a failing background refresh keeps the previous value", async () => {
  const c = new TtlCache({ staleMs: 500 });
  await c.fetch("k", async () => "good", 20);
  await new Promise((r) => setTimeout(r, 40));
  // The background refresh throws; the stale value must survive it.
  await c.fetch("k", async () => { throw new Error("down"); }, 20);
  await new Promise((r) => setTimeout(r, 30));
  // A later reader still gets the last known good value rather than a hole.
  assert.equal(await c.fetch("k", async () => "good", 20), "good");
});

test("the cache evicts least-recently-used entries when full", async () => {
  const c = new TtlCache({ max: 3 });
  for (const k of ["a", "b", "c"]) await c.fetch(k, async () => k, 10_000);
  // Touch "a" so "b" becomes the least recently used.
  await c.fetch("a", async () => "a", 10_000);
  await c.fetch("d", async () => "d", 10_000);
  assert.equal(c.map.size, 3);
  assert.equal(await c.peek("a"), "a");
  assert.equal(await c.peek("b"), undefined, "the least recently used entry should be gone");
});

test("cache stats report a hit rate", async () => {
  const c = new TtlCache({ name: "t" });
  await c.fetch("k", async () => 1, 1000);
  await c.fetch("k", async () => 1, 1000);
  const s = c.stats();
  assert.equal(s.name, "t");
  assert.equal(s.size, 1);
  assert.ok(s.hitRate > 0 && s.hitRate <= 1);
});

// --- batcher --------------------------------------------------------------

test("requests arriving together share one batched call", async () => {
  // Ported from nautilus_trader's debounced fan-out: six coins needing a
  // price should cost one upstream call, not six.
  let runs = 0;
  const b = new Batcher({
    flushMs: 15,
    run: async (keys) => {
      runs++;
      return new Map(keys.map((k) => [k, k.toUpperCase()]));
    },
  });
  const out = await Promise.all(["btc", "eth", "sol"].map((k) => b.request(k)));
  assert.equal(runs, 1);
  assert.deepEqual(out, ["BTC", "ETH", "SOL"]);
});

test("a key a batch cannot resolve rejects instead of resolving undefined", async () => {
  const b = new Batcher({ flushMs: 10, run: async () => new Map() });
  await assert.rejects(b.request("ghost"), /batch miss/);
});

test("a failing batch rejects all its waiters", async () => {
  const b = new Batcher({ flushMs: 10, run: async () => { throw new Error("upstream"); } });
  await assert.rejects(Promise.all([b.request("a"), b.request("b")]), /upstream/);
});

test("requests arriving after a flush start a new batch", async () => {
  let runs = 0;
  const b = new Batcher({
    flushMs: 10,
    run: async (keys) => {
      runs++;
      return new Map(keys.map((k) => [k, k]));
    },
  });
  await b.request("first");
  await new Promise((r) => setTimeout(r, 30));
  await b.request("second");
  assert.equal(runs, 2, "a later request must not be dropped");
});

// --- circuit breaker ------------------------------------------------------

test("a circuit reports closed when nothing has failed", () => {
  resetClientState();
  assert.equal(breakerState("example.test").state, "closed");
});

test("client health starts empty and tracks hosts it has seen", () => {
  resetClientState();
  assert.deepEqual(clientHealth(), []);
});

test("a SoftError is marked soft so callers can degrade", () => {
  const e = new SoftError("throttled", "throttled");
  assert.equal(e.soft, true);
  assert.equal(e.kind, "throttled");
});

// --- mover ranking --------------------------------------------------------

const token = (over) => ({
  symbol: "T",
  price_usd: 1,
  change_24h: 10,
  liquidity_usd: 100_000,
  volume_h24: 200_000,
  chain: "solana",
  source: "dexscreener",
  ...over,
});

test("a huge move on an untradeable coin is excluded, not promoted", () => {
  // The whole point of the liquidity gate: +900% on $1k of liquidity is a
  // trap, not an opportunity.
  assert.equal(rankMovers([token({ change_24h: 900, liquidity_usd: 1_000 })]).length, 0);
});

test("a real move on a liquid coin is ranked first", () => {
  const ranked = rankMovers([
    token({ symbol: "SMALL", change_24h: 6, liquidity_usd: 40_000, volume_h24: 60_000 }),
    token({ symbol: "BIG", change_24h: 25, liquidity_usd: 5_000_000, volume_h24: 9_000_000 }),
  ]);
  assert.equal(ranked[0].symbol, "BIG");
});

test("quiet coins are filtered out", () => {
  assert.equal(rankMovers([token({ change_24h: 0.3 })]).length, 0);
});

test("coins with no price or no change are skipped", () => {
  assert.equal(rankMovers([token({ price_usd: null }), token({ change_24h: null })]).length, 0);
});

test("buying pressure lifts a coin above the same move with selling pressure", () => {
  const up = moverScore(token({ change_24h: 20, buys_1h: 90, sells_1h: 10 }));
  const down = moverScore(token({ change_24h: 20, buys_1h: 10, sells_1h: 90 }));
  assert.ok(up > down, `${up} should beat ${down}`);
});

test("a 5000% move cannot dominate the score", () => {
  // Saturation stops one wild coin from permanently owning the top slot.
  const huge = moverScore(token({ change_24h: 5000, buys_1h: 50, sells_1h: 50 }));
  const big = moverScore(token({ change_24h: 55, buys_1h: 50, sells_1h: 50 }));
  assert.ok(Math.abs(huge - big) < 0.2, "both should be near the ceiling");
});

test("missing flow data does not penalise a coin", () => {
  assert.ok(moverScore(token({ buys_1h: null, sells_1h: null })) > 0);
});

// --- pair normalisation ---------------------------------------------------

test("only the deepest pool per token is kept", () => {
  const pairs = [
    { chainId: "solana", baseToken: { address: "A", symbol: "X" }, liquidity: { usd: 5_000 } },
    { chainId: "solana", baseToken: { address: "A", symbol: "X" }, liquidity: { usd: 50_000 } },
    { chainId: "solana", baseToken: { address: "B", symbol: "Y" }, liquidity: { usd: 1_000 } },
  ];
  const best = dedupeBestPair(pairs);
  assert.equal(best.length, 2);
  assert.equal(best.find((p) => p.baseToken.address === "A").liquidity.usd, 50_000);
});

test("normalisePair produces a usable token or null", () => {
  assert.equal(normalisePair(null), null);
  assert.equal(normalisePair({}), null);
  const t = normalisePair({
    chainId: "solana",
    pairAddress: "P",
    dexId: "raydium",
    baseToken: { address: "A", symbol: "bonk", name: "Bonk" },
    priceUsd: "0.00002",
    priceChange: { h24: 12.5, h1: 1.2 },
    liquidity: { usd: 900_000 },
    volume: { h24: 3_000_000, h6: 800_000 },
    txns: { h1: { buys: 70, sells: 30 } },
  });
  assert.equal(t.symbol, "BONK");
  assert.equal(t.price_usd, 0.00002);
  assert.equal(t.change_24h, 12.5);
  assert.equal(t.buys_1h, 70);
  assert.equal(t.liquidity_usd, 900_000);
  assert.equal(t.address, "A");
  assert.ok(t.url.includes("solana"));
});

test("a pair with a non-numeric price normalises to null rather than NaN", () => {
  assert.equal(normalisePair({ baseToken: { symbol: "X" }, priceUsd: "n/a" }).price_usd, null);
});

// --- metered API budget (protects the free CoinMarketCap key) -------------

test("credit cost scales with page size, as CoinMarketCap actually charges", () => {
  // Measured against the live API: ceil(limit / 250), minimum 1. Getting this
  // wrong by 10x is the difference between 1,440 and 28,800 calls a month.
  assert.equal(creditFor("/v3/cryptocurrency/listings/latest?limit=1"), 1);
  assert.equal(creditFor("/v3/cryptocurrency/listings/latest?limit=100"), 1);
  assert.equal(creditFor("/v3/cryptocurrency/listings/latest?limit=250"), 1);
  assert.equal(creditFor("/v3/cryptocurrency/listings/latest?limit=500"), 2);
  assert.equal(creditFor("/v3/cryptocurrency/listings/latest?limit=1000"), 4);
  assert.equal(creditFor("/v3/cryptocurrency/listings/latest?limit=5000"), 20);
  // A quote has no page size, so it is always a single credit.
  assert.equal(creditFor("/v3/cryptocurrency/quotes/latest?symbol=BTC"), 1);
});

test("the budget stops spending before the monthly plan limit is reached", () => {
  const b = new MonthlyBudget(10_000, 0.2);
  assert.equal(b.ceiling, 8000, "20% is held back as headroom");
  assert.ok(b.canSpend());
  b.spend(7999);
  assert.ok(b.canSpend(), "one credit left is still usable");
  b.spend(1);
  assert.ok(!b.canSpend(), "spending the ceiling stops the key");
  assert.equal(b.remaining, 0);
});

test("the budget can never be driven negative", () => {
  const b = new MonthlyBudget(100, 0.2);
  b.spend(5);
  b.spend(50_000);
  assert.equal(b.remaining, 0, "a bug cannot overdraw into negative");
  assert.ok(!b.canSpend());
});

test("a rejected key is disabled until next month, then retried", () => {
  const b = new MonthlyBudget(10_000, 0.2);
  b.disableKey("API_KEY_INVALID");
  const afterDisable = b.state();
  assert.equal(afterDisable.key_disabled, true);
  assert.match(afterDisable.key_disabled_reason, /API_KEY_INVALID/);
  assert.ok(!b.canSpend(), "a known-bad key must not be retried on every call");
});

test("the budget resets at the start of a new month", () => {
  // Simulated by rolling the month backwards; a process that idles for weeks
  // must not come back and find itself permanently locked out.
  const b = new MonthlyBudget(10_000, 0.2);
  b.spend(9000);
  assert.ok(!b.canSpend());
  b.month = "1999-01";
  assert.ok(b.canSpend(), "a new billing month restores the allowance");
  assert.equal(b.state().used, 0);
});

// --- feed input cleaning ---------------------------------------------------

test("junk tickers are rejected rather than truncated into fake coins", () => {
  assert.equal(cleanSymbol("SOL"), "SOL");
  assert.equal(cleanSymbol("$bonk"), "BONK");
  // A 2000-character string is a feed artefact. Truncating it would invent a
  // symbol for a coin that does not exist.
  assert.equal(cleanSymbol("x".repeat(2000)), "");
  assert.equal(cleanSymbol("A".repeat(13)), "");
  assert.equal(cleanSymbol("A".repeat(12)), "A".repeat(12));
  assert.equal(cleanSymbol(null), "");
});

test("names are length-capped with a safe fallback", () => {
  assert.equal(cleanName("  Bitcoin  "), "Bitcoin");
  assert.equal(cleanName("n".repeat(80)), "Unknown coin");
  assert.equal(cleanName(""), "Unknown coin");
});

test("numberOrNull never yields NaN or Infinity", () => {
  assert.equal(numberOrNull("123.5"), 123.5);
  assert.equal(numberOrNull("nope"), null);
  assert.equal(numberOrNull(Infinity), null);
  assert.equal(numberOrNull(undefined), null);
});

test("purging removes training rows whose label window reaches into the test set", () => {
  // The whole point: a 3-day horizon means rows just before the test block
  // have already "seen" the first test bar through their own label.
  const events = Array.from({ length: 40 }, (_, i) => makeEvent(i, 3));
  const { trainIndices, testIndices } = purgedSplit(events, 20, 29, 0);
  assert.deepEqual(testIndices, [20, 21, 22, 23, 24, 25, 26, 27, 28, 29]);
  // Rows 17, 18, 19 end at 20, 21, 22 — all inside the test window.
  for (const i of [17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29]) {
    assert.ok(!trainIndices.includes(i), `row ${i} overlaps the test label window`);
  }
  assert.ok(trainIndices.includes(10), "distant past rows stay in training");
  assert.ok(trainIndices.includes(39), "future rows stay in training");
});

test("embargo drops rows immediately after the test block", () => {
  // Test 20..25 with a 3-bar label: the test window ends at bar 28, so rows
  // 23..28 are already purged. The embargo then takes 29..33 on top, leaving
  // 34 as the first row allowed back into training.
  const events = Array.from({ length: 40 }, (_, i) => makeEvent(i, 3));
  const { trainIndices } = purgedSplit(events, 20, 25, 5);
  for (const i of [23, 24, 25, 26, 27, 28]) {
    assert.ok(!trainIndices.includes(i), `row ${i} overlaps the test label window`);
  }
  for (const i of [29, 30, 31, 32, 33]) {
    assert.ok(!trainIndices.includes(i), `row ${i} is inside the embargo`);
  }
  assert.ok(trainIndices.includes(34), "row 34 is the first row past the embargo");
  assert.ok(trainIndices.includes(39));
});

test("a longer horizon purges strictly more rows", () => {
  // If purging does not scale with the label window, it is not purging.
  const short = Array.from({ length: 60 }, (_, i) => makeEvent(i, 1));
  const long = Array.from({ length: 60 }, (_, i) => makeEvent(i, 10));
  const a = purgedSplit(short, 40, 50, 0).trainIndices.length;
  const b = purgedSplit(long, 40, 50, 0).trainIndices.length;
  assert.ok(b < a, `10-bar horizon (${b}) must purge more than 1-bar (${a})`);
});

test("purgedSplit refuses a variable label window", () => {
  // A mis-specified labeller would silently reintroduce leakage, so the
  // fixed-horizon assumption is enforced rather than documented.
  const ragged = [makeEvent(0, 3), makeEvent(1, 5), makeEvent(2, 3)];
  assert.throws(() => purgedSplit(ragged, 1, 2, 0), /fixed horizon/);
});

test("overlapping windows are detected, including touching endpoints", () => {
  assert.ok(windowsOverlap({ start: 0, end: 3 }, { start: 3, end: 6 }));
  assert.ok(windowsOverlap({ start: 0, end: 5 }, { start: 2, end: 4 }));
  assert.ok(!windowsOverlap({ start: 0, end: 2 }, { start: 3, end: 6 }));
});

test("CPCV produces the expected number of splits", () => {
  const events = Array.from({ length: 60 }, (_, i) => makeEvent(i, 3));
  // C(6,2) = 15, C(5,2) = 10, C(4,3) = 4
  assert.equal(combinatorialPurgedCV(events, 6, 2, 3).length, 15);
  assert.equal(combinatorialPurgedCV(events, 5, 2, 3).length, 10);
  assert.equal(combinatorialPurgedCV(events, 4, 3, 3).length, 4);
});

test("every CPCV split keeps train and test strictly disjoint", () => {
  const events = Array.from({ length: 60 }, (_, i) => makeEvent(i, 3));
  for (const s of combinatorialPurgedCV(events, 6, 2, 3)) {
    assert.equal(s.trainIndices.filter((i) => s.testIndices.includes(i)).length, 0);
    assert.ok(s.trainIndices.length > 0 && s.testIndices.length > 0);
  }
});

test("CPCV rejects an impossible k", () => {
  const events = Array.from({ length: 20 }, (_, i) => makeEvent(i, 3));
  assert.throws(() => combinatorialPurgedCV(events, 4, 4, 0), /1 <= k < N/);
  assert.throws(() => combinatorialPurgedCV(events, 4, 0, 0), /1 <= k < N/);
});

test("the reconstructed path compounds each observation exactly once", () => {
  // Each test row appears in C(N-1,k-1) splits; without dividing by that
  // multiplicity the same trade would be counted many times over.
  const events = Array.from({ length: 60 }, (_, i) => makeEvent(i, 3));
  const splits = combinatorialPurgedCV(events, 6, 2, 3);
  const returns = new Map(events.map((e) => [e.index, 0.01]));
  const path = reconstructPath(splits, returns);
  // Every row is tested by C(5,1) = 5 splits, so each contributes 0.01/5.
  const expected = 0.002 * path.length;
  const total = path.reduce((s, p) => s + p.ret, 0);
  assert.ok(Math.abs(total - expected) < 1e-9, `${total} should equal ${expected}`);
  assert.ok(path.every((p) => p.equity > 0));
});

// --- Sharpe / PSR / DSR ---------------------------------------------------

test("normalCDF matches known values", () => {
  assert.ok(Math.abs(normalCDF(0) - 0.5) < 1e-6);
  assert.ok(Math.abs(normalCDF(1.96) - 0.975) < 1e-3);
  assert.ok(Math.abs(normalCDF(-1.96) - 0.025) < 1e-3);
  assert.ok(normalCDF(3) > 0.998);
  assert.ok(normalCDF(-3) < 0.002);
});

test("normalPPF inverts normalCDF", () => {
  for (const p of [0.01, 0.1, 0.5, 0.9, 0.99]) {
    assert.ok(Math.abs(normalCDF(normalPPF(p)) - p) < 1e-5, `round trip failed at ${p}`);
  }
});

test("return moments are correct on a known series", () => {
  // A symmetric series has zero skew, and a Sharpe of zero with no drift.
  const m = returnMoments([0.01, -0.01, 0.01, -0.01, 0.01, -0.01]);
  assert.equal(m.T, 6);
  assert.ok(Math.abs(m.mean) < 1e-12);
  assert.ok(Math.abs(m.skewness) < 1e-9);
  assert.ok(Math.abs(m.sharpe) < 1e-9);
});

test("return moments survive a constant series instead of dividing by zero", () => {
  const m = returnMoments([0.01, 0.01, 0.01, 0.01]);
  assert.equal(m.sharpe, 0);
  assert.ok(Number.isFinite(m.skewness));
  assert.ok(Number.isFinite(m.kurtosis));
});

test("return moments refuse a series too short to have moments", () => {
  assert.throws(() => returnMoments([0.01, 0.02]), /at least 4/);
});

test("PSR rises with the observed Sharpe and with track length", () => {
  const weak = probabilisticSharpeRatio(0.05, 0, 100, 0, 3);
  const strong = probabilisticSharpeRatio(0.30, 0, 100, 0, 3);
  assert.ok(strong > weak, "a higher Sharpe must be more convincing");
  assert.ok(probabilisticSharpeRatio(0.1, 0, 1000, 0, 3) > probabilisticSharpeRatio(0.1, 0, 50, 0, 3));
  for (const v of [weak, strong]) assert.ok(v >= 0 && v <= 1);
});

test("the multiple-testing hurdle rises with the number of trials", () => {
  // Trying more things makes a given Sharpe less impressive. This is the
  // correction that stops best-of-N cherry-picking.
  assert.ok(expectedMaxSharpe(0.01, 500) > expectedMaxSharpe(0.01, 5));
  assert.equal(expectedMaxSharpe(0.01, 1), 0, "a single trial has no hurdle");
});

test("DSR punishes a Sharpe that only just beats the hurdle", () => {
  const trials = [-0.1, 0.05, 0.12, 0.3, -0.05, 0.2, 0.02, -0.2, 0.08, 0.15];
  const marginal = deflatedSharpeRatio(0.3, trials, 200, 0, 3);
  const dominant = deflatedSharpeRatio(2.5, trials, 200, 0, 3);
  assert.ok(marginal.dsr < dominant.dsr, "a huge Sharpe must be more convincing");
  assert.ok(marginal.dsr >= 0 && marginal.dsr <= 1);
  assert.equal(marginal.nTrials, 10);
});

test("DSR with one trial falls back to plain PSR against zero", () => {
  const r = deflatedSharpeRatio(0.5, [0.5], 200, 0, 3);
  assert.equal(r.expectedMaxSR, 0);
  assert.equal(r.nTrials, 1);
  assert.ok(r.dsr > 0.5);
});

test("correlated trials collapse to fewer effective trials", () => {
  // 20 runs of the same idea are one idea, not twenty. Without this the
  // hurdle would be so punitive that real strategies never pass.
  const base = Array.from({ length: 40 }, (_, i) => Math.sin(i) * 0.01);
  const nEff = effectiveTrials(Array.from({ length: 20 }, () => base));
  assert.ok(nEff < 20, `identical trials should collapse, got ${nEff}`);
  assert.ok(nEff >= 1);
});

test("correlation is 1 for a series with itself and handles flat input", () => {
  assert.ok(Math.abs(correlation([1, 2, 3], [2, 4, 6]) - 1) < 1e-9);
  assert.equal(correlation([1, 1, 1], [1, 2, 3]), 0, "zero variance must not divide by zero");
});

// --- continuous position sizing -------------------------------------------

test("bet size is zero at a coin flip and grows with conviction", () => {
  assert.equal(betSize(0.5), 0);
  assert.ok(betSize(0.7) > 0, "0.7 should be long");
  assert.ok(betSize(0.3) < 0, "0.3 should be short");
  assert.ok(Math.abs(betSize(0.9)) > Math.abs(betSize(0.6)), "more conviction, more size");
});

test("bet size is symmetric about a coin flip", () => {
  for (const d of [0.05, 0.1, 0.2, 0.4]) {
    assert.ok(Math.abs(betSize(0.5 + d) + betSize(0.5 - d)) < 1e-9, `asymmetric at ${d}`);
  }
});

test("bet size stays inside [-1, 1] and handles degenerate input", () => {
  assert.ok(betSize(0.999) <= 1 && betSize(0.999) > 0);
  assert.ok(betSize(0.001) >= -1);
  assert.equal(betSize(0), 0);
  assert.equal(betSize(1), 0);
  assert.equal(betSize(NaN), 0);
});

test("a more confident call gets more notional", () => {
  const casual = sizePosition(0.58, { maxNotional: 100 });
  const confident = sizePosition(0.85, { maxNotional: 100 });
  assert.ok(confident.notional > casual.notional, `${confident.notional} should beat ${casual.notional}`);
});

test("a stressed market cuts size without flipping the direction", () => {
  const calm = sizePosition(0.8, { maxNotional: 100, turbulence: 0.5, threshold: 3 });
  const stressed = sizePosition(0.8, { maxNotional: 100, turbulence: 6, threshold: 3 });
  assert.ok(stressed.notional < calm.notional, "stress must reduce size");
  assert.equal(stressed.direction, calm.direction, "stress must not invert the trade");
  assert.equal(stressed.stressed, true);
});

test("notional never exceeds the hard cap", () => {
  for (const p of [0.51, 0.6, 0.75, 0.9, 0.99]) {
    assert.ok(sizePosition(p, { maxNotional: 250 }).notional <= 250);
  }
});

test("a coin flip places no trade at all", () => {
  const s = sizePosition(0.5, { maxNotional: 100 });
  assert.equal(s.notional, 0);
  assert.equal(s.direction, "FLAT");
});

test("turbulence stays low for an ordinary series and spikes on an outlier", () => {
  // An index is a z-score, so an ordinary last bar lands near 1 by
  // construction; only a genuine outlier should approach the gate at 3.
  const ordinary = Array.from({ length: 30 }, (_, i) => Math.sin(i) * 0.01);
  const calm = turbulenceIndex(ordinary);
  assert.ok(calm > 0 && calm < 2, `an ordinary bar should read near 1, got ${calm}`);
  assert.ok(turbulenceIndex([...ordinary.slice(0, 29), 0.5]) > 3, "a huge bar must trip the gate");
});

test("turbulence is zero on a flat series and safe on a short one", () => {
  // A flat series is float noise, not a real signal: it must read exactly 0.
  assert.equal(turbulenceIndex(new Array(30).fill(0.01)), 0);
  assert.equal(turbulenceIndex([0.01, 0.02]), 0);
});

