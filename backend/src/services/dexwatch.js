/**
 * DEX observation collector.
 *
 * Collects point-in-time DEX state from DexScreener and stores it in Supabase so
 * features can be built later by asking "what was true at bar t".
 *
 * Two design rules, both learned the hard way earlier in this project:
 *
 * 1. **Observations only, never a trade trigger.** Nothing here decides to
 *    trade. These rows are training material for `dexfeatures.js`, and the
 *    promotion gate in `evaluate.js` remains the only thing that can promote a
 *    model. A collector that fired trades would bypass the exact protection the
 *    app was built around.
 *
 * 2. **Quota-bounded, degrading rather than failing.** Every call goes through
 *    `quota.js`. When a budget is exhausted the collector backs off instead of
 *    continuing, because this data feeds training: a sparser history still
 *    trains, a suspended API key costs a month.
 *
 * Pure parsing functions are exported separately from the fetching so the shape
 * of a provider response can be tested without a network or an API key. That
 * split is the whole reason a provider payload change shows up as a test
 * failure instead of as empty rows three days later.
 */

import { createBudgets, LIMITS } from "../ml/quota.js";

const DEX_BASE = "https://api.dexscreener.com";
const DEFAULT_TIMEOUT_MS = 8000;

/** Chains worth collecting. Solana first — it is the deployment target. */
export const WATCH_CHAINS = ["solana", "ethereum", "base", "arbitrum", "bsc", "polygon", "avalanche"];

/**
 * Minimum pool liquidity worth recording, per chain.
 *
 * These mirror the floors in `ml/chains.js` (Solana 100k, Ethereum 500k) rather
 * than inventing new numbers. Collecting a pool we would refuse to trade wastes
 * quota and pollutes the training set with observations that can never become a
 * trade — and worse, a `liquidity_trend` feature built from them would describe
 * a market state we would never act on.
 */
export const MIN_POOL_LIQUIDITY_USD = {
  solana: 100_000,
  ethereum: 500_000,
  base: 100_000,
  arbitrum: 100_000,
  bsc: 100_000,
  polygon: 100_000,
  avalanche: 100_000,
};

/** Process-wide budgets. One instance, so windows are shared across collectors. */
export const budgets = createBudgets();

/* ── parsing (pure) ───────────────────────────────────────────────────────── */

/**
 * Parse one DexScreener pair object into our snapshot shape.
 *
 * Returns null rather than a partial object when the essentials are missing.
 * A row with a null price is worse than no row: it would satisfy a
 * `liquidity > 0` check in a feature while describing nothing.
 */
export function parsePair(pair) {
  if (!pair || typeof pair !== "object") return null;
  if (!pair.baseToken?.address) return null;

  const price = Number(pair.priceUsd ?? pair.priceNative ?? NaN);
  if (!Number.isFinite(price) || price <= 0) return null;

  const txns = pair.txns ?? {};
  const window5m = txns.m5 ?? {};
  const window1h = txns.h1 ?? {};
  const window24h = txns.h24 ?? {};

  // Sum across the window's timeframes so the counts mean "buys and sells in
  // the 24h window" rather than an unlabelled number from an arbitrary field.
  const buys = sumFinite(window24h.buys, window1h.buys, window5m.buys);
  const sells = sumFinite(window24h.sells, window1h.sells, window5m.sells);

  return {
    symbol: String(pair.baseToken.symbol ?? "").toUpperCase(),
    address: pair.baseToken.address,
    chain: pair.chainId ?? null,
    dex_id: pair.dexId ?? null,
    pair_address: pair.pairAddress ?? null,
    price_usd: price,
    liquidity_usd: numOrNull(pair.liquidity?.usd),
    volume_usd: numOrNull(pair.volume?.h24),
    price_change_5m: numOrNull(pair.priceChange?.m5),
    price_change_1h: numOrNull(pair.priceChange?.h1),
    price_change_24h: numOrNull(pair.priceChange?.h24),
    buys,
    sells,
    source: "dexscreener",
    // The full payload is kept so a mis-derived feature can be rebuilt later
    // without re-fetching. This is the difference between a data-quality bug
    // being fixable and being permanent.
    raw: pair,
  };
}

/** Parse a DexScreener `{ pairs: [...] }` response, dropping unusable rows. */
export function parsePairsResponse(json, { chains = null } = {}) {
  const pairs = Array.isArray(json?.pairs) ? json.pairs : [];
  const out = [];
  for (const p of pairs) {
    const parsed = parsePair(p);
    if (!parsed) continue;
    if (chains && !chains.includes(parsed.chain)) continue;
    out.push(parsed);
  }
  return out;
}
/* ── fetching ─────────────────────────────────────────────────────────────── */

/**
 * Rate-limited fetch. Returns null on any failure rather than throwing.
 *
 * A collector that throws on one bad symbol stops the whole tick; a null lets
 * the caller skip that row and keep going, which is what a training feed wants.
 */
async function fetchJson(url, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch the top pairs for a chain from DexScreener's search endpoint.
 * Returns [] when the budget is exhausted — that is the degrading path.
 */
/**
 * Search queries per chain.
 *
 * MEASURED, not guessed. Probing the real endpoint showed that a bare token
 * name is close to useless here:
 *
 *   q=solana    -> 21 pairs, 1 distinct symbol, 0 with a priceChange
 *   q=bonk      -> 20 pairs, 1 symbol
 *   q=SOL/USDC  -> 25 pairs, 9 distinct symbols, all 5 kept rows usable
 *
 * A chain name or a token name matches pair names, which returns dozens of
 * pools for one asset and — for the stable-quoted ones — no price movement at
 * all. A PAIR query returns a genuine cross-section.
 *
 * So discovery is driven by pair queries, and `fetchPairsForToken` is the path
 * for per-token polling once a token is known. If this list ever goes stale the
 * collector still runs; it just gets a narrower cross-section, which shows up
 * in the `usable rows` line of scripts/probe-dex.js.
 */
export const DEFAULT_QUERIES = {
  solana: ["SOL/USDC", "SOL/USDT", "BTC/USDC"],
  ethereum: ["ETH/USDC", "ETH/USDT", "WBTC/USDC"],
  base: ["ETH/USDC", "WETH/USDC"],
  arbitrum: ["ETH/USDC", "ARB/USDC"],
  bsc: ["BNB/USDT", "CAKE/USDT"],
  polygon: ["MATIC/USDC", "WETH/USDC"],
  avalanche: ["AVAX/USDC", "WAVAX/USDC"],
};

/**
 * Fetch candidate pairs for a chain from DexScreener's search endpoint.
 * Returns [] when the budget is exhausted — that is the degrading path.
 *
 * Spends one budget unit per query, not per chain, so the collector's cost is
 * proportional to how many cross-sections it actually wants rather than to how
 * many chains it knows about.
 */
export async function fetchTopPairs(chain, { queries = null, limit = 30 } = {}) {
  const list = queries ?? DEFAULT_QUERIES[chain] ?? [`${chain.toUpperCase()}/USDC`];
  const out = [];

  for (const query of list) {
    if (!budgets.dexscreenerPairs.take()) return rankAndFilter(out, {
      limit,
      minLiquidityUsd: MIN_POOL_LIQUIDITY_USD[chain] ?? 20_000,
    });
    const url = `${DEX_BASE}/latest/dex/search?q=${encodeURIComponent(query)}&chainId=${encodeURIComponent(chain)}`;
    const json = await fetchJson(url);
    if (!json) continue;
    out.push(...parsePairsResponse(json, { chains: [chain] }));
  }

  // The search endpoint is a TEXT search, not a ranking, and it returns dust
  // pools: live checks found pools with an empty priceChange and a single buy in
  // 24h. Storing those is worse than storing nothing — they look like
  // observations, so a feature derived from them is confidently built on a pool
  // where nobody trades. Liquidity is the filter that matters, because a pool
  // with no liquidity cannot be traded at any price and `chains.js` already
  // refuses anything under 100k for Solana.
  return rankAndFilter(out, { limit, minLiquidityUsd: MIN_POOL_LIQUIDITY_USD[chain] ?? 20_000 });
}

/**
 * The pools endpoint by token address, which is what per-token polling needs.
 *
 * Preferred over search once a token is known, because it returns every pool for
 * exactly that token and nothing else — no dedup across unrelated assets, and no
 * dependence on a text query matching.
 */
export async function fetchPairsForToken(address, chain = "solana") {
  if (!budgets.dexscreenerPairs.take()) return [];

  const url = `${DEX_BASE}/latest/dex/pairs/${encodeURIComponent(chain)}/${encodeURIComponent(address)}`;
  const json = await fetchJson(url);
  if (!json) return [];

  const parsed = parsePairsResponse(json, { chains: [chain] });
  const floor = MIN_POOL_LIQUIDITY_USD[chain] ?? 20_000;
  return rankAndFilter(parsed, { limit: 5, minLiquidityUsd: floor });
}

/**
 * Order candidates by liquidity and drop the ones too thin to trade.
 *
 * Pure, and exported so the ranking can be tested against a fixed list rather
 * than against whatever the provider returns today.
 */
export function rankAndFilter(pairs, { limit = 30, minLiquidityUsd = 20_000 } = {}) {
  // One token can have many pools. Without this, a single deep token (SOL has
  // dozens) fills the whole budget and the collector observes one asset 30
  // times, which would make any cross-sectional feature degenerate.
  const byToken = new Map();
  for (const p of pairs) {
    if (!Number.isFinite(p.liquidity_usd) || p.liquidity_usd < minLiquidityUsd) continue;
    const prev = byToken.get(p.address);
    if (!prev) {
      byToken.set(p.address, p);
      continue;
    }
    // Keep the most informative row for a token. Order matters: COMPLETENESS
    // first, then depth. Reading it the other way round — deeper pool first,
    // then "use it if it has priceChange" — silently throws away the one row
    // that reports movement whenever a shallower pool has it, which is exactly
    // the row a mover feature needs.
    const prevComplete = Number.isFinite(prev.price_change_1h);
    const pComplete = Number.isFinite(p.price_change_1h);
    if (pComplete && !prevComplete) byToken.set(p.address, p);
    else if (pComplete === prevComplete && p.liquidity_usd > prev.liquidity_usd) byToken.set(p.address, p);
    continue;
  }

  return [...byToken.values()]
    // ORDER: complete rows first, then by liquidity.
    //
    // Sorting purely by liquidity is actively harmful here. Measured live:
    // DexScreener returns no `priceChange` at all on the deepest SOL/USDC pools,
    // so a liquidity-first sort fills the entire budget with rows whose price
    // movement is null — 0/10 usable. Depth-first ordering therefore collects
    // nothing a feature can use, while spending the quota to do it.
    //
    // Liquidity is still the tiebreak within a completeness tier, and still the
    // gate above it, so an untradeable pool is never recorded either way.
    .sort((a, b) => {
      const ac = Number.isFinite(a.price_change_1h) ? 1 : 0;
      const bc = Number.isFinite(b.price_change_1h) ? 1 : 0;
      if (ac !== bc) return bc - ac;
      return (b.liquidity_usd ?? 0) - (a.liquidity_usd ?? 0);
    })
    .slice(0, limit);
}

/**
 * One collection tick: gather what the quota allows, hand it to `persist`.
 *
 * `persist` is injected so the collector can be tested with a fake sink and no
 * database. It receives an array of parsed snapshots and returns how many it
 * actually stored, which is what gets reported — a tick that fetched 30 rows and
 * stored 0 is not a successful tick and must not be logged as one.
 */
export async function collectOnce({
  chains = WATCH_CHAINS,
  queries = null,
  limit = 30,
  persist,
  now = () => new Date().toISOString(),
} = {}) {
  const all = [];
  let budgetDenied = 0;

  for (const chain of chains) {
    const pairs = await fetchTopPairs(chain, { queries, limit });
    if (budgets.dexscreenerPairs.remaining() <= 0) budgetDenied++;
    all.push(...pairs);
  }

  if (typeof persist !== "function") {
    return { fetched: all.length, stored: 0, budget_denied: budgetDenied, rows: all };
  }

  // Stamp each row at collection time. This is the timestamp every feature
  // joins on, so it must be the observation time and not the provider's own
  // window boundary.
  const ts = now();
  const rows = all.map((r) => ({ ...r, ts }));
  const stored = await persist(rows);

  return { fetched: all.length, stored, budget_denied: budgetDenied, rows };
}

/**
 * Persistence adapter: store parsed snapshots into Supabase (or the local JSON
 * store when no database is configured).
 *
 * Returns the number ACTUALLY stored. A collector that fetched 30 rows and
 * stored none must report 0, not 30 — otherwise the health check reads healthy
 * while the feature stays permanently untrained.
 */
export async function persistSnapshots(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  const { insertRows } = await import("../store.js");
  return insertRows("dex_snapshots", rows);
}

/**
 * One collection tick, wired to persistence.
 *
 * `chains` defaults to Solana only, deliberately. Collecting seven chains every
 * 30 seconds would spend most of the DexScreener budget on pools that will never
 * be traded, and the feature is being built for Solana first. Widen it once there
 * is evidence Solana is working.
 */
export async function tick({ chains = ["solana"], limit = 30, now } = {}) {
  const result = await collectOnce({
    chains,
    limit,
    persist: persistSnapshots,
    now,
  });

  // A tick that fetched nothing and stored nothing is the normal state when the
  // quota is spent, so it logs at one level; a tick that FETCHED rows and then
  // failed to STORE them is a real fault and logs loudly. Those two states look
  // identical in a quiet log otherwise, and only one of them is a bug.
  if (result.fetched > 0 && result.stored === 0) {
    console.warn(`[dexwatch] fetched ${result.fetched} but stored none — check the dex_snapshots table exists`);
  } else if (result.stored > 0) {
    console.log(`[dexwatch] stored ${result.stored} snapshots`);
  }
  return result;
}

/* ── helpers ──────────────────────────────────────────────────────────────── */

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Sum the finite values only, so a missing timeframe does not become NaN. */
function sumFinite(...vals) {
  let total = 0;
  for (const v of vals) {
    const n = Number(v);
    if (Number.isFinite(n)) total += n;
  }
  return total;
}

/**
 * Quota state for the health route and dashboard.
 *
 * Surfaced rather than kept internal because a collector quietly throttling
 * itself looks identical to a market going quiet, and those need to be
 * distinguishable when you are trying to work out why training data stopped.
 */
export function quotaStatus() {
  return {
    dexscreener_pairs_remaining: budgets.dexscreenerPairs.remaining(),
    dexscreener_pairs_limit: LIMITS.dexscreener.pairsPerMinute,
    helius_standard_remaining: budgets.heliusStandard.remaining(),
    helius_das_remaining: budgets.heliusDas.remaining(),
    credits: budgets.credits.status(),
  };
}