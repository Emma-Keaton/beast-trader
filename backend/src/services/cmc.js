/**
 * CoinMarketCap access, quota-safe for the free Hobby plan.
 *
 * Four things about this API are easy to get wrong, and each one is handled
 * explicitly below rather than discovered in production:
 *
 * 1. **The V1 endpoints this code used to call are deprecated.**
 *    `/v1/cryptocurrency/listings/latest` and `/v1/cryptocurrency/quotes/latest`
 *    both appear in CMC's Deprecated list. The live paths are V3. Calling a
 *    deprecated path with a Hobby key is how you get a surprise 403.
 *
 * 2. **There is an official keyless API.** CMC publishes
 *    `pro-api.coinmarketcap.com/public-api/...` — same host, same JSON
 *    envelope, no key, IP-based rate pool. That is a far better fallback than
 *    scraping the website, and it costs the user none of their quota.
 *
 * 3. **Credit cost scales with `limit`.** Measured against the live API:
 *    limit=100 costs 1 credit, 500 costs 2, 1000 costs 4, 5000 costs 20 —
 *    i.e. `ceil(limit / 250)`. A naive "fetch the top 500 every 3 minutes"
 *    loop burns ~28,800 credits a month and would exhaust a 10,000 Hobby plan
 *    in ten days. Hence the small page and the long cache below.
 *
 * 4. **Errors arrive as HTTP 200.** A failed CMC call returns
 *    `status.error_code: 1005` with a 200 status, so a check on `res.ok`
 *    alone treats an error page as good data. Every response is validated
 *    against its own `status` block.
 *
 * The budget guard in `core/budget.js` means a free key cannot be exhausted by
 * a bug or a traffic spike: once the monthly allowance is spent, requests fall
 * through to the keyless API and the app carries on.
 */

import { config } from "../config.js";
import { getJSON, SoftError } from "../core/http.js";
import { cmcBudget, creditFor } from "../core/budget.js";
import { cleanSymbol, cleanName, numberOrNull } from "./clean.js";

// Keyed root, and the official keyless root. Same host, different prefix.
const ROOT = "https://pro-api.coinmarketcap.com";
const KEYLESS = `${ROOT}/public-api`;

/** Current (non-deprecated) endpoint versions. */
const LISTINGS = "/v3/cryptocurrency/listings/latest";
const QUOTES = "/v3/cryptocurrency/quotes/latest";

/**
 * Cache lifetimes, chosen so the Hobby plan is never at risk.
 *
 * At limit=100 (1 credit) and a 30-minute refresh this is 48 credits/day,
 * about 1,440 a month — roughly 14% of the 10,000 Hobby allowance, leaving
 * ample room for growth. The DEX sweep supplies the genuinely fast-moving
 * "big movers" list; this feed covers large caps, which do not move
 * meaningfully in under half an hour.
 */
export const CMC_TTL = {
  listing: 30 * 60_000,
  quote: 5 * 60_000,
};

/**
 * One page size for the whole module.
 *
 * 100 coins by market cap is enough to rank locally: the filters in
 * `cmcMovers` discard anything under $5M cap anyway, and the top 100 by cap
 * is where every coin that passes that filter lives. Going wider costs
 * credits and returns rows we would throw away.
 */
const PAGE = 100;

/** True when a usable key is configured, for the health endpoint. */
export const cmcHasKey = () => Boolean(config.cmcApiKey);

/**
 * CMC returns HTTP 200 with an error envelope, so success is decided by the
 * body's own status block, never by the HTTP code alone.
 */
function assertOk(body) {
  // CMC returns error_code inconsistently typed: the healthy response is the
  // number 0 on some routes and the *string* "0" on others. A strict `=== 0`
  // therefore rejects perfectly good data, which is how this feed ended up
  // silently returning an empty list while the API was working fine.
  const raw = body?.status?.error_code;
  const code = raw == null || raw === "" ? 0 : Number(raw);
  if (Number.isFinite(code) && code === 0) return body;

  const message = body?.status?.error_message || `cmc error ${raw}`;
  const err = new SoftError(message, "cmc-envelope");
  err.code = code;
  // 401/403-class codes mean the key itself is the problem; the caller falls
  // back and stops trying, rather than burning quota on a known-bad key.
  err.keyProblem = [1001, 1002, 1005, 1006, 1007].includes(code);
  throw err;
}

/**
 * Pull the USD quote out of a record.
 *
 * V3 returns `quote` as an **array** of per-currency objects, where the older
 * documented shape used an object keyed by currency (`quote.USD`). Both are
 * handled so a format change upstream degrades to "no price" rather than a
 * crash or a silent zero.
 */
function usdQuote(record) {
  const q = record?.quote;
  if (Array.isArray(q)) return q.find((x) => x?.symbol === "USD") ?? q[0] ?? null;
  if (q && typeof q === "object") return q.USD ?? Object.values(q)[0] ?? null;
  return null;
}

/** Normalise one record to the shape the rest of the app speaks. */
function normalise(record) {
  const quote = usdQuote(record);
  return {
    symbol: cleanSymbol(record?.symbol),
    name: cleanName(record?.name),
    price_usd: numberOrNull(quote?.price),
    change_24h: numberOrNull(quote?.percent_change_24h),
    volume_24h: numberOrNull(quote?.volume_24h),
    market_cap: numberOrNull(quote?.market_cap),
    rank: record?.cmc_rank ?? null,
  };
}

/**
 * Issue one CMC request against whichever API the budget allows.
 *
 * Order of preference is deliberate:
 *  - **Keyed** while there is monthly budget left. The key's higher rate limit
 *    is the reason it exists.
 *  - **Keyless** once the budget is spent, or when no key is configured. This
 *    consumes none of the user's allowance, so a free key can never be
 *    exhausted by a traffic spike.
 */
async function request(path) {
  if (config.cmcApiKey && cmcBudget.canSpend()) {
    const credits = creditFor(path);
    try {
      const body = await getJSON(`${ROOT}${path}`, {
        headers: { "X-CMC_PRO_API_KEY": config.cmcApiKey },
        timeoutMs: 10_000,
        retries: 1,
      });
      assertOk(body);
      cmcBudget.spend(credits);
      return Array.isArray(body?.data) ? body.data : [];
    } catch (err) {
      // A bad key must never be an outage: warn once, then use the keyless
      // path for the rest of the month.
      // Two shapes reach here: a rejected key returns a real HTTP 401/403
      // from the transport, while some failures only appear in the JSON
      // envelope. Both are classified, so neither is retried forever.
      const byStatus = err?.status === 401 || err?.status === 403;
      if (err?.keyProblem || byStatus) {
        cmcBudget.disableKey(err.message);
        console.warn(`[cmc] key rejected (${err.message}); using the keyless public API from now on`);
      } else if (!(err instanceof SoftError)) {
        console.warn(`[cmc] keyed request failed (${err.message}); falling back to keyless`);
      }
    }
  }
  // Keyless: no X-CMC_PRO_API_KEY header, per CMC's own documentation.
  const body = await getJSON(`${KEYLESS}${path}`, { timeoutMs: 10_000, retries: 1 });
  assertOk(body);
  return Array.isArray(body?.data) ? body.data : [];
}

// A tiny module-local cache so repeated calls within one process cost nothing.
const listingCache = new Map();

/** Top coins by market cap, already normalised and cached. */
export function cmcTopCoins(limit = PAGE) {
  return cmcListing("market_cap", limit);
}

/**
 * A cached page of listings. The page size is clamped, so a caller can never
 * accidentally ask for a 5,000-row page and spend 20 credits on data we would
 * throw away.
 */
function cmcListing(sort = "market_cap", limit = PAGE) {
  const size = Math.min(Math.max(1, limit), 250);
  const key = `${sort}:${size}`;
  const hit = listingCache.get(key);
  if (hit && !hit.inflight && Date.now() < hit.expires) return Promise.resolve(hit.rows);

  const path = `${LISTINGS}?start=1&limit=${size}&sort=${encodeURIComponent(sort)}&sort_dir=desc&convert=USD`;
  const inflight = request(path)
    .then((rows) => {
      const clean = rows.map(normalise).filter((r) => r.symbol && r.price_usd != null);
      listingCache.set(key, { rows: clean, expires: Date.now() + CMC_TTL.listing });
      return clean;
    })
    .catch((err) => {
      if (!(err instanceof SoftError)) console.warn(`[cmc] listing failed: ${err.message}`);
      // Serve the last good page rather than an empty list, even if stale.
      return hit?.rows ?? [];
    });
  listingCache.set(key, { rows: hit?.rows ?? [], expires: hit?.expires ?? 0, inflight });
  return inflight;
}

/** Reference price and stats for one ticker, budget-aware. */
export function cmcQuote(symbol) {
  const sym = String(symbol || "").toUpperCase();
  if (!sym) return Promise.resolve(null);
  return request(`${QUOTES}?symbol=${encodeURIComponent(sym)}&convert=USD`)
    .then((rows) => {
      const row = rows.map(normalise).find((r) => r.symbol === sym);
      return row ? { ...row, source: "coinmarketcap" } : null;
    })
    .catch(() => null);
}

/** Budget state for the health endpoint and the admin view. */
export const cmcBudgetState = () => cmcBudget.state();

/**
 * Everything the health endpoint needs to explain, in one field, which API is
 * actually answering right now. A silent switch to keyless is exactly the
 * kind of thing that should be visible rather than inferred from a slow page.
 */
export function cmcStatus() {
  const s = cmcBudget.state();
  const mode = !config.cmcApiKey
    ? "keyless"
    : s.key_disabled
      ? "keyless-key-rejected"
      : s.remaining > 0
        ? "keyed"
        : "keyless-budget-spent";
  return { ...s, has_key: Boolean(config.cmcApiKey), mode };
}
