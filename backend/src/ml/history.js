/**
 * Historical OHLCV fetching for training and for live model scoring.
 *
 * Primary source is Binance's public klines endpoint: it needs no API key,
 * has generous limits, and returns *real* exchange candles (open/high/low/
 * close/volume). That matters — training on synthesised ranges teaches the
 * model about a market that does not exist.
 *
 * CoinGecko remains a fallback (and supports a demo key via
 * `COINGECKO_API_KEY`) for symbols Binance does not list. Its free tier now
 * requires a key for chart data, so it is not the default.
 *
 * Everything is cached to disk: re-training is then instant and offline.
 */

import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { getJSON as httpGet } from "../core/http.js";

const CG = "https://api.coingecko.com/api/v3";
const BN = "https://api.binance.com/api/v3";
const CACHE_DIR = path.join(config.dataDir, "history");
const CACHE_TTL = 12 * 3600_000;

/** Training universe: deep, liquid pairs that Binance actually lists. */
export const TRAINING_UNIVERSE = [
  { id: "bitcoin", symbol: "BTC", pair: "BTCUSDT" },
  { id: "ethereum", symbol: "ETH", pair: "ETHUSDT" },
  { id: "solana", symbol: "SOL", pair: "SOLUSDT" },
  { id: "ripple", symbol: "XRP", pair: "XRPUSDT" },
  { id: "cardano", symbol: "ADA", pair: "ADAUSDT" },
  { id: "dogecoin", symbol: "DOGE", pair: "DOGEUSDT" },
  { id: "avalanche-2", symbol: "AVAX", pair: "AVAXUSDT" },
  { id: "chainlink", symbol: "LINK", pair: "LINKUSDT" },
  { id: "polkadot", symbol: "DOT", pair: "DOTUSDT" },
  { id: "litecoin", symbol: "LTC", pair: "LTCUSDT" },
  { id: "uniswap", symbol: "UNI", pair: "UNIUSDT" },
  { id: "near", symbol: "NEAR", pair: "NEARUSDT" },
];

/** Best-effort USDT pair for a CoinGecko id, for live model scoring. */
export function guessPair(idOrSymbol) {
  const s = String(idOrSymbol).toUpperCase().replace(/[^A-Z0-9]/g, "");
  return `${s}USDT`;
}

/**
 * Training fetch uses the shared HTTP client, so it inherits the same
 * circuit breaker, self-throttling and backoff as the live poller. A rate
 * limit during training must not be handled differently to one in production.
 */
async function getJSON(url, timeoutMs = 20_000, headers = {}) {
  return httpGet(url, { timeoutMs, retries: 2, headers, userAgent: "beast-trader/0.1 (training)" });
}

/**
 * Daily bars for a coin. Tries Binance, then CoinGecko.
 *
 * @param opts.offline  never touch the network. A cached file is served at ANY
 *   age (the TTL below is a freshness rule for live scoring, not a rule about
 *   what training may read), and a missing cache is an error rather than a
 *   reason to fetch. Without this, `train --offline` silently went to the
 *   network whenever the cache was older than 12h — which on a machine that
 *   trains weekly was always.
 * @returns `{ id, symbol, bars: [{t,o,h,l,c,v}], source, cached? }`
 */
export async function fetchDailyBars(id, symbol = id, days = 5000, opts = {}) {
  const { offline = false } = opts;
  const file = path.join(CACHE_DIR, `${id}.json`);
  const cached = readCache(file, { maxAgeMs: offline ? Infinity : CACHE_TTL });
  if (cached) return { ...cached, cached: true };
  if (offline) throw new Error(`${id}: no cached history (offline mode)`);

  let bars = [];
  let source = "";
  try {
    bars = await fetchBinance(guessPair(symbol || id), days);
    source = "binance";
  } catch (e) {
    if (!config.coingeckoKey) throw e;
    const j = await getJSON(
      `${CG}/coins/${id}/market_chart?vs_currency=usd&days=${Math.min(days, 365)}&interval=daily`,
      20_000,
      { "x-cg-demo-api-key": config.coingeckoKey },
    );
    bars = synthesiseCandles(j);
    source = "coingecko";
  }
  if (bars.length < 100) throw new Error(`${id}: only ${bars.length} bars available`);

  const payload = { id, symbol, bars, source, fetchedAt: new Date().toISOString() };
  writeCache(file, payload);
  return payload;
}

/**
 * Binance daily klines, paginated backwards through history.
 *
 * Binance returns at most 1,000 rows per call, so a single request covers
 * only ~2.7 years of daily candles. That was the binding limit on this
 * project's training data: with 12 coins x 1,000 bars the out-of-sample
 * window was only ~2,500 rows, far too small to distinguish a real edge from
 * noise — the honest evaluation produced a confident-looking result on 14
 * trades, which is a small-sample artefact rather than a strategy.
 *
 * Walking `startTime` backwards in 1,000-bar pages multiplies the usable
 * history by five at no extra cost, and 5,000 daily bars is ~13 years, which
 * spans several complete market cycles. The API is public and keyless, and
 * these are a handful of requests per coin, done once and cached to disk.
 *
 * @param pair  e.g. "BTCUSDT"
 * @param days  how many daily bars to aim for
 */
export async function fetchBinance(pair, days = 5000) {
  const target = Math.max(1, Math.min(days, 10_000));
  const PAGE = 1000;
  const DAY = 86_400_000;

  const byTime = new Map();
  let cursor = Date.now();

  for (let page = 0; page * PAGE < target; page++) {
    const rows = await getJSON(
      `${BN}/klines?symbol=${pair}&interval=1d&limit=${PAGE}&endTime=${cursor}`,
    );
    if (!Array.isArray(rows) || !rows.length) break;

    let oldest = Infinity;
    for (const k of rows) {
      byTime.set(k[0], { t: k[0], o: Number(k[1]), h: Number(k[2]), l: Number(k[3]), c: Number(k[4]), v: Number(k[5]) });
      if (k[0] < oldest) oldest = k[0];
    }
    // Stop when a page returns fewer rows than requested: the beginning of
    // the asset's history has been reached.
    if (rows.length < PAGE) break;
    cursor = oldest - DAY;
  }

  return [...byTime.values()]
    .filter((b) => Number.isFinite(b.c) && b.c > 0)
    .sort((a, b) => a.t - b.t)
    .slice(-target);
}

function readCache(file, { maxAgeMs = CACHE_TTL } = {}) {
  try {
    if (maxAgeMs !== Infinity) {
      const stat = fs.statSync(file);
      if (Date.now() - stat.mtimeMs > maxAgeMs) return null;
    }
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeCache(file, payload) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(payload));
  } catch {
    /* cache is an optimisation, never fatal */
  }
}

/**
 * CoinGecko returns closes only. Build candles from them: open = previous
 * close, high/low padded by a small proportional range. Only used as a
 * fallback, and flagged via `source` so it is never mistaken for real
 * exchange candles.
 */
export function synthesiseCandles(j) {
  const prices = (j.prices || []).filter(([, p]) => p > 0);
  const volumes = new Map((j.total_volumes || []).map(([t, v]) => [t, v]));
  return prices.map(([t, c], i) => {
    const o = i > 0 ? prices[i - 1][1] : c;
    const range = c * 0.006;
    return {
      t,
      o,
      h: Math.max(o, c) + range,
      l: Math.max(0, Math.min(o, c) - range),
      c,
      v: volumes.get(t) ?? 0,
    };
  });
}
