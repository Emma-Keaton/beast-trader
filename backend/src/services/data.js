/**
 * Market data sources.
 *
 * Every provider here is keyless and chosen for its free-tier generosity.
 * This replaces the earlier CoinGecko-centric design, whose chart endpoint now
 * demands a key and whose price endpoint throttles aggressively.
 *
 *  - **DexScreener** (300 req/min, no key) — live DEX pairs across Solana,
 *    Base, Ethereum and most other chains, with liquidity, volume and
 *    transaction counts. The workhorse for anything on-chain.
 *  - **DefiLlama** (~300 req/min, no key, 400+ chains) — a second price
 *    opinion by contract address, used to cross-check a DEX quote instead of
 *    trusting a single pool.
 *  - **Binance public ticker** (no key) — reference prices for listed coins,
 *    and the same venue the training candles come from.
 *
 * All of it goes through the caching layer, so a dashboard open on several
 * panels still results in one upstream request per key.
 */

import { getJSON, SoftError } from "../core/http.js";
import { TtlCache } from "../core/cache.js";
import { cmcQuote, cmcTopCoins, CMC_TTL, cmcHasKey, cmcBudgetState } from "./cmc.js";
import { cleanName, cleanSymbol, numberOrNull } from "./clean.js";

const DS = "https://api.dexscreener.com";
const LLAMA_COINS = "https://coins.llama.fi";
const LLAMA = "https://api.llama.fi";
const BN = "https://api.binance.com/api/v3";

export const cache = new TtlCache({ max: 800, staleMs: 15_000, name: "market-data" });

/**
 * TTLs encode how fast the data actually changes. 20s on a price is
 * generous; 5 minutes on a trending list is still fresh. Both are far inside
 * the free-tier request budget.
 */
const TTL = {
  trending: 120_000,
  search: 60_000,
  price: 20_000,
  chainVolume: 300_000,
  cmc: 180_000,
};

async function soft(fn, fallback) {
  try {
    return await fn();
  } catch (e) {
    // A throttle must never take down a poll. A hard failure is logged so it
    // stays visible, but is still not fatal here.
    if (!e?.soft) console.warn("[data]", e.message);
    return fallback;
  }
}

/** Popular coins across the market, from keyless trending + boosted tokens. */
// Not an Express handler: this is a cached data-source function. The lint
// rule matches on shape, not on whether the function is mounted on a router.
export function trending() {
  return cache.fetch("trending", loadTrending, TTL.trending);
}

async function loadTrending() {
  const boosts = await soft(() => getJSON(`${DS}/token-boosts/latest/v1`, { retries: 1 }), []);
  const profiles = await soft(() => getJSON(`${DS}/token-profiles/latest/v1`, { retries: 1 }), []);

  // Promoted tokens are the closest keyless signal to "what is moving now",
  // and each entry carries a pair URL we can resolve in a single call.
  const seen = new Map();
  for (const row of [...boosts, ...profiles]) {
    const key = `${row.chainId}:${row.tokenAddress}`;
    if (!seen.has(key)) {
      seen.set(key, {
        chainId: row.chainId,
        tokenAddress: row.tokenAddress,
        icon: row.icon ?? null,
        url: row.url ?? null,
      });
    }
  }

  const pairs = await resolvePairs([...seen.values()]);
  const byKey = new Map();
  for (const p of pairs.filter(Boolean)) {
    const t = normalisePair(p, { icon: seen.get(`${p.chainId}:${p.baseToken?.address}`)?.icon });
    // One row per contract: the same token can appear in both the boost and
    // the profile feed, and duplicates would crowd out real movers.
    if (t && t.price_usd != null) byKey.set(`${t.chain}:${t.address}`, t);
  }

  const out = [...byKey.values()]
    .sort((a, b) => (b.liquidity_usd ?? 0) - (a.liquidity_usd ?? 0))
    .slice(0, 12);

  if (out.length) return out;

  // Fall back to plain search if the boost feed produced nothing usable.
  const fallback = await soft(() => getJSON(`${DS}/latest/dex/search?q=SOL%20USDC`, { retries: 1 }), null);
  return (fallback?.pairs ?? []).slice(0, 12).map((p) => normalisePair(p)).filter(Boolean);
}

/** Free-text search across every chain DexScreener indexes. */
export async function search(query) {
  const q = String(query || "").trim();
  if (!q) return [];
  return cache.fetch(`search:${q.toLowerCase()}`, async () => {
    const j = await soft(() => getJSON(`${DS}/latest/dex/search?q=${encodeURIComponent(q)}`, { retries: 1 }), null);
    return dedupeBestPair(j?.pairs).map((p) => normalisePair(p)).filter(Boolean).slice(0, 24);
  }, TTL.search);
}

/** Best (deepest) pool for a symbol, optionally pinned to one chain. */
export async function bestPair(symbol, chain) {
  const key = `pair:${chain || "*"}:${symbol.toUpperCase()}`;
  return cache.fetch(key, async () => {
    const j = await soft(() => getJSON(`${DS}/latest/dex/search?q=${encodeURIComponent(symbol)}`, { retries: 1 }), null);
    const pairs = (j?.pairs ?? []).filter(
      (p) =>
        String(p.baseToken?.symbol || "").toUpperCase() === symbol.toUpperCase() &&
        (!chain || p.chainId === chain),
    );
    const best = dedupeBestPair(pairs)[0];
    return best ? normalisePair(best) : null;
  }, TTL.price);
}

/** Live 24h stats for a listed coin, from Binance's keyless ticker. */
export async function listedTicker(symbol) {
  const pair = `${String(symbol).toUpperCase().replace(/[^A-Z0-9]/g, "")}USDT`;
  return cache.fetch(`ticker:${pair}`, async () => {
    const j = await soft(() => getJSON(`${BN}/ticker/24hr?symbol=${pair}`, { timeoutMs: 6000, retries: 1 }), null);
    const last = Number(j?.lastPrice);
    if (!Number.isFinite(last) || last <= 0) return null;
    return {
      price_usd: last,
      change_24h: Number(j.priceChangePercent) || 0,
      volume_h24: Number(j.quoteVolume) || 0,
      high_24h: Number(j.highPrice) || 0,
      low_24h: Number(j.lowPrice) || 0,
      source: "binance",
      pair,
    };
  }, TTL.price);
}

/** DefiLlama price for one contract address — a cross-check on a DEX quote. */
export async function llamaPrice(chain, address) {
  if (!chain || !address) return null;
  return cache.fetch(`llama:${chain}:${address}`, async () => {
    const j = await soft(
      () => getJSON(`${LLAMA_COINS}/prices/current/${chain}:${address}`, { timeoutMs: 6000, retries: 1 }),
      null,
    );
    const row = j?.coins?.[`${chain}:${address}`];
    return row ? { price: Number(row.price), confidence: row.confidence ?? null } : null;
  }, TTL.price);
}

/** 24h DEX volume for a chain, to show where the activity actually is. */
export async function chainVolume(chain) {
  const slug = String(chain || "").toLowerCase();
  if (!slug) return null;
  return cache.fetch(`chainvol:${slug}`, async () => {
    const j = await soft(
      () =>
        getJSON(`${LLAMA}/overview/dexs/${slug}?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true`, { retries: 1 }),
      null,
    );
    if (!j) return null;
    return { chain: j.chain ?? slug, total24h: j.total24h ?? null, change_1d: j.change_1d ?? null, dexCount: j.dexs?.length ?? 0 };
  }, TTL.chainVolume);
}

/**
 * CoinMarketCap, thin wrapper over `cmc.js`.
 *
 * The API, quota and keyless-fallback logic all live in their own module
 * because the details matter a great deal and are easy to get wrong; this
 * layer only applies the two product rules on top: the tradeability floor,
 * and the fact that CMC's own gainers sort is unusable.
 */
export function cmcQuotes(symbol) {
  return cache.fetch(`cmc:${String(symbol).toUpperCase()}`, () => cmcQuote(symbol), CMC_TTL.quote);
}

/**
 * Top CMC listings by 24h move, with the same tradeability floor used for
 * DEX movers. A coin with a $40 market cap that "up 400%" is not a mover,
 * it is a rounding error, and it is filtered out here.
 */
export function cmcMovers(limit = 12, opts = {}) {
  const { minMarketCap = 5_000_000, minVolume = 500_000, minAbsChange = 2 } = opts;
  return cache.fetch(
    `cmcmovers:${limit}`,
    async () => {
      // Ranked locally from the top-100-by-market-cap page, never from CMC's
      // "biggest gainers" sort: that list is led by unvetted micro-caps with a
      // market cap of literally $0 and eight-figure percentages, which the
      // filters below would reject anyway — returning nothing at all. Taking
      // the real, liquid coins and ranking them here is the only version of
      // this list a beginner should ever see.
      const rows = await cmcTopCoins();
      return rows
        .filter((t) => Number.isFinite(t.change_24h))
        .filter((t) => (t.market_cap ?? 0) >= minMarketCap)
        .filter((t) => (t.volume_24h ?? 0) >= minVolume)
        .filter((t) => Math.abs(t.change_24h) >= minAbsChange)
        .sort((a, b) => b.change_24h - a.change_24h)
        .slice(0, limit)
        .map((t) => ({ ...t, volume_h24: t.volume_24h, chain: "coingecko", source: "coinmarketcap" }));
    },
    CMC_TTL.listing,
  );
}

export { cmcHasKey, cmcBudgetState };

/** Today's biggest movers, computed locally from the boosted-token universe. */
// Not an Express handler either — a cached data-source function.
export function topMovers(limit = 12) {
  return cache.fetch(`movers:${limit}`, () => trending().then((u) => rankMovers(u, limit)), TTL.trending);
}

/**
 * The market's biggest movers, merged across every source we can see.
 *
 * DEX and listed feeds are combined and de-duplicated by ticker, because a
 * coin often appears in both. Each row is tagged with where it came from, and
 * the DEX side is preferred when both are present: it carries the liquidity
 * figure that decides whether the coin can actually be traded.
 */
/**
 * Chains to sweep when hunting for movers.
 *
 * DexScreener has no "top gainers across every chain" endpoint, so broad
 * discovery means searching the deepest quote asset on each chain we care
 * about. These six are where most retail flow actually sits; the shared rate
 * limiter keeps the sweep polite.
 */
const SWEEP_QUERIES = [
  { q: "SOL/USDC", chain: "solana" },
  { q: "WETH/USDC", chain: "base" },
  { q: "ETH/USDC", chain: "ethereum" },
  { q: "WBNB/USDT", chain: "bsc" },
  { q: "WETH/USDC", chain: "arbitrum" },
  { q: "SUI/USDC", chain: "sui" },
];

/**
 * Multi-chain discovery sweep.
 *
 * One search per representative pair per chain, filtered to the chain so a
 * "SOL" result on Base cannot masquerade as Solana. Sequential on purpose:
 * these share the global rate limiter, and firing them in parallel would only
 * queue up and time out.
 */
export async function discoverPairs() {
  const found = [];
  for (const { q, chain } of SWEEP_QUERIES) {
    const j = await soft(() => getJSON(`${DS}/latest/dex/search?q=${encodeURIComponent(q)}`, { retries: 0 }), null);
    const pairs = (j?.pairs ?? []).filter((p) => p.chainId === chain);
    // Deepest pool per token on this chain, so a thin clone pool cannot
    // outrank the real one on raw price change.
    found.push(...dedupeBestPair(pairs));
  }
  return found;
}

/**
 * The market's biggest movers, merged across every source we can see.
 *
 * Two feeds, deliberately balanced rather than merged by raw percentage.
 * CoinMarketCap lists large caps that can print +30% in a day; the DEX sweep
 * finds smaller on-chain coins moving just as hard. Sorting the union purely
 * by percentage lets CMC's dozen rows evict every DEX token, and the result is
 * then a list of coins with no on-chain liquidity behind them. So the two
 * feeds each get half the slots, and DEX rows break ties.
 */
export function allMovers(limit = 12) {
  return cache.fetch(`allmovers:${limit}`, async () => {
    const [boosted, sweep, listed] = await Promise.all([
      topMovers(limit).catch(() => []),
      discoverPairs()
        .then((pairs) => rankMovers(pairs.map((p) => normalisePair(p)).filter(Boolean), limit * 3))
        .catch(() => []),
      cmcMovers(limit).catch(() => []),
    ]);

    const dex = mergeTokens([...boosted, ...sweep]);
    const merged = mergeTokens([...dex, ...listed]);
    const dexRows = merged.filter((t) => t.sources.includes("dexscreener"));
    const otherRows = merged.filter((t) => !t.sources.includes("dexscreener"));

    // Alternate so both halves of the market are always represented, with
    // leftover slots going to whichever side has more to show.
    const out = [];
    const half = Math.max(1, Math.floor(limit / 2));
    for (let i = 0; i < half; i++) {
      if (dexRows[i]) out.push(dexRows[i]);
      if (otherRows[i]) out.push(otherRows[i]);
    }
    const rest = merged.filter((t) => !out.includes(t));
    return [...out, ...rest].slice(0, limit);
  }, TTL.trending);
}

/**
 * De-duplicate tokens from overlapping feeds, keeping the richest row.
 *
 * A token can appear in the boost feed, the chain sweep and CoinMarketCap at
 * once, and often under two different contract addresses on one chain (a
 * bridged copy). Contract address is the primary identity; chain + symbol is
 * the alias index, so one coin never fills the whole list.
 */
function mergeTokens(rows) {
  const byKey = new Map();
  const bySymbol = new Map();
  for (const t of rows) {
    if (!t?.symbol || t.price_usd == null) continue;
    const alias = `${t.chain}:${t.symbol}`;
    const key = t.address ? `${t.chain}:${t.address}` : alias;
    const held = byKey.get(key) ?? bySymbol.get(alias);
    if (!held) {
      const row = { ...t, sources: [t.source] };
      byKey.set(key, row);
      bySymbol.set(alias, row);
    } else if (!held.sources.includes(t.source)) {
      held.sources = [...held.sources, t.source];
    }
  }
  return [...byKey.values()].sort(
    (a, b) => (b.momentum ?? Math.abs(b.change_24h ?? 0)) - (a.momentum ?? Math.abs(a.change_24h ?? 0)),
  );
}

/**
 * Rank by size of move, filtered for tradeability.
 *
 * A +400% move on a coin with $3k of liquidity is not an opportunity, it is a
 * trap — you cannot get in or out. The minimum-liquidity and minimum-volume
 * gates are applied *before* ranking, which is what makes this list useful
 * rather than a wall of unusable numbers.
 */
export function rankMovers(universe, limit = 12, opts = {}) {
  const { minLiquidity = 20_000, minVolume = 50_000, minAbsChange = 2 } = opts;
  return (universe ?? [])
    .filter((t) => t.price_usd != null && Number.isFinite(t.change_24h))
    .filter((t) => (t.liquidity_usd ?? 0) >= minLiquidity)
    .filter((t) => (t.volume_h24 ?? 0) >= minVolume)
    .filter((t) => Math.abs(t.change_24h) >= minAbsChange)
    .map((t) => ({ ...t, momentum: moverScore(t) }))
    .sort((a, b) => b.momentum - a.momentum)
    .slice(0, limit);
}

/**
 * A single "how interesting is this move" score.
 *
 * Size of the move matters most, but an unconfirmed move is discounted: when
 * more coins are being sold than bought over the last hour, a rally is more
 * likely to be people exiting than people arriving. Turnover relative to
 * liquidity separates a real move from a thin-market twitch.
 */
export function moverScore(t) {
  const move = Math.min(Math.abs(t.change_24h ?? 0), 60) / 60;
  const turnover = Math.min((t.volume_h24 ?? 0) / Math.max(t.liquidity_usd ?? 1, 1), 5) / 5;
  const buys = t.buys_1h;
  const sells = t.sells_1h;
  // +1 when every recent trade was a buy, -1 when every one was a sell.
  const flow = buys != null && sells != null && buys + sells > 0 ? (buys - sells) / (buys + sells) : 0;
  return Number((move * 0.6 + turnover * 0.25 + flow * 0.15).toFixed(4));
}

// ── helpers ───────────────────────────────────────────────────────────────

/**
 * Keep only the deepest pool per token. Without this, a search for a common
 * ticker returns ten copies of the same coin on thin DEXes and the user sees
 * the same symbol ten times.
 */
export function dedupeBestPair(pairs) {
  const best = new Map();
  for (const p of pairs ?? []) {
    const key = `${p.chainId}:${p.baseToken?.address ?? p.pairAddress}`;
    const held = best.get(key);
    if (!held || (p.liquidity?.usd ?? 0) > (held.liquidity?.usd ?? 0)) best.set(key, p);
  }
  return [...best.values()];
}

/**
 * Resolve promoted-token rows to live pairs.
 *
 * The fan-out is capped and strictly sequential: one request per entry is
 * unavoidable with this API, and politeness on a shared free-tier IP matters
 * more than completeness.
 */
async function resolvePairs(rows) {
  const out = [];
  for (const row of rows.slice(0, 12)) {
    const url = pairUrl(row);
    if (!url) continue;
    const j = await soft(() => getJSON(`${DS}${url}`, { timeoutMs: 6000, retries: 1 }), null);
    // A token can have several pools; the deepest one is the tradeable one.
    const pair = dedupeBestPair(j?.pairs ?? [])[0];
    if (pair) out.push(pair);
  }
  return out;
}

/**
 * Build the API path for a promoted-token row.
 *
 * The correct endpoint is `/token-pairs/v1/{chainId}/{tokenAddress}`. Two
 * mistakes are guarded against here, because both fail as a silent 404 that
 * leaves the whole trending feed empty:
 *
 *  - `/latest/dex/tokens/...` does not exist on the API host. The `latest/dex`
 *    prefix only applies to `search` and `pairs`.
 *  - the `url` field is a *website* link (dexscreener.com/solana/<addr>), not
 *    an API path, so its pathname must never be pasted onto the API host.
 */
function pairUrl({ chainId, tokenAddress, url }) {
  if (chainId && tokenAddress) return `/token-pairs/v1/${chainId}/${tokenAddress}`;

  // Last resort: a website URL such as "https://dexscreener.com/solana/<addr>",
  // whose two path segments are a valid chain/pair lookup.
  if (url) {
    try {
      const [, chain, address] = new URL(url).pathname.split("/");
      if (chain && address) return `/latest/dex/pairs/${chain}/${address}`;
    } catch {
      return null;
    }
  }
  return null;
}

/** Map a DexScreener pair to the shape the whole app speaks. */
export function normalisePair(p, extra = {}) {
  if (!p?.baseToken) return null;
  const price = Number(p.priceUsd);
  return {
    id: p.pairAddress,
    // Promoted feeds occasionally carry junk in the symbol field (an emoji
    // soup of 2000 characters). Anything unreadable is dropped here rather
    // than rendered into a card or sent to an exchange.
    symbol: cleanSymbol(p.baseToken.symbol),
    name: cleanName(p.baseToken.name ?? p.baseToken.symbol),
    address: p.baseToken.address,
    price_usd: Number.isFinite(price) && price > 0 ? price : null,
    change_24h: numberOrNull(p.priceChange?.h24),
    change_1h: numberOrNull(p.priceChange?.h1),
    change_5m: numberOrNull(p.priceChange?.m5),
    chain: p.chainId,
    dex: p.dexId,
    pair_address: p.pairAddress,
    liquidity_usd: numberOrNull(p.liquidity?.usd),
    volume_h24: numberOrNull(p.volume?.h24),
    volume_6h: numberOrNull(p.volume?.h6),
    // Buys vs sells in the last hour: the cheapest available read on whether
    // a move is being accumulated or distributed.
    buys_1h: numberOrNull(p.txns?.h1?.buys),
    sells_1h: numberOrNull(p.txns?.h1?.sells),
    pair_created_at: p.pairCreatedAt ?? null,
    icon: extra.icon ?? null,
    url: `https://dexscreener.com/${p.chainId}/${p.pairAddress}`,
    source: "dexscreener",
  };
}

export { cleanSymbol, cleanName, numberOrNull } from "./clean.js";

export { SoftError };

