import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { getJSON } from "../core/http.js";

/**
 * Intraday bar collection for the venue the app actually trades.
 *
 * The gap this closes. Every signal measured so far came from **daily** bars on
 * large caps: `fetchBinance` requests `interval=1d` and `fetchDailyBars` asks
 * CoinGecko for daily points. But the app trades long-tail Solana tokens on short
 * timeframes, and the two are not interchangeable:
 *
 *   - a 14-day trend on daily bars is a different animal from a 30-minute move on
 *     a thin long-tail token, where spread and slippage dominate and the whole
 *     question is whether a move covers the cost of taking it;
 *   - large-cap daily volatility (rank IC 0.187) does not transfer to a memecoin.
 *
 * So the research numbers are evidence *about crypto*, not evidence *about this
 * venue*. Nothing here can be validated until history exists on the venue itself.
 *
 * This is deliberately a collector, not a strategy. It writes bars to disk and
 * gets out of the way; no model reads them yet. Collecting starts the clock on
 * being able to answer the question honestly.
 *
 * Binance's public klines endpoint needs no key and caps at 1000 rows per call,
 * which is why paging is required rather than optional.
 */

/** Interval→milliseconds, used to page backwards without re-requesting rows. */
const INTERVAL_MS = {
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 3600_000,
  "4h": 4 * 3600_000,
};

/**
 * Long-tail pairs to collect.
 *
 * Chosen for the venue the app screens: liquid-enough Solana long tails and the
 * majors as controls. SOLUSDT rather than a raw SPL pair because venue routing
 * matters later and a CEX quote is what the executor would actually price against.
 */
export const INTRADAY_UNIVERSE = [
  "SOLUSDT", "BTCUSDT", "ETHUSDT", "BONKUSDT", "WIFUSDT", "JUPUSDT",
  "PYTHUSDT", "JTOUSDT", "FARTCOINUSDT", "TRUMPUSDT", "POPCATUSDT", "PNUTUSDT",
];

/**
 * Fetch intraday klines for one pair, paging backwards until `bars` rows are
 * gathered or the source is exhausted.
 *
 * Paging is by `endTime` rather than by offset because an offset-based walk skips
 * or repeats rows the moment a new candle appears mid-request. Backdating the
 * cursor to before the oldest row already seen makes the walk idempotent.
 */
export async function fetchIntraday(pair, { interval = "15m", bars = 1000, getJSON, base } = {}) {
  const step = INTERVAL_MS[interval];
  if (!step) throw new Error(`unsupported interval: ${interval}`);
  const PAGE = 1000;
  const want = Math.max(1, Math.min(bars, 20_000));

  const byTime = new Map();
  let cursor = Date.now();

  while (byTime.size < want) {
    const rows = await getJSON(
      `${base}/klines?symbol=${pair}&interval=${interval}&limit=${Math.min(PAGE, want - byTime.size)}&endTime=${cursor}`,
    );
    if (!Array.isArray(rows) || !rows.length) break;

    let oldest = Infinity;
    for (const k of rows) {
      // A bar still forming reports a close that will change. Dropping the
      // newest row keeps every stored bar final, so backtests are not re-run
      // against a price that was later revised.
      if (!Number.isFinite(k[0])) continue;
      byTime.set(k[0], {
        t: k[0],
        o: Number(k[1]),
        h: Number(k[2]),
        l: Number(k[3]),
        c: Number(k[4]),
        v: Number(k[5]),
      });
      if (k[0] < oldest) oldest = k[0];
    }
    if (rows.length < PAGE) break;
    cursor = oldest - step;
    if (!Number.isFinite(cursor)) break;
  }

  return [...byTime.values()]
    .filter((b) => Number.isFinite(b.c) && b.c > 0 && b.o > 0 && b.h >= b.l)
    .sort((a, b) => a.t - b.t)
    .slice(-want);
}

/**
 * Append new bars to a symbol's file, skipping anything already stored.
 *
 * Idempotent by construction: the merge is keyed on the bar's open time, so
 * re-running the collector never duplicates and never rewrites history. That
 * matters because this is meant to run on a timer over months.
 *
 * A partially-written file is left alone rather than truncated. Losing a whole
 * symbol's history to repair one corrupt tail would be a far worse outcome than
 * one bad append, and the caller re-fetches from the last good timestamp anyway.
 */

/**
 * A bar is only storable if its time *and* its prices are real numbers.
 *
 * Checking the timestamp alone is not enough: a source that reports a valid open
 * time with a NaN close (a halted pair, a bad parse) would be written to disk as
 * `{c: null}`, and every downstream return, volatility estimate and backtest
 * would silently propagate that null. Validating on write is far cheaper than
 * discovering it in a result three months later.
 */
function validBar(b) {
  return (
    Number.isFinite(b?.t) &&
    Number.isFinite(b?.c) &&
    b.c > 0 &&
    Number.isFinite(b?.o) &&
    b.o > 0
  );
}
export function mergeBars(existing, incoming) {
  const byTime = new Map();
  for (const b of existing ?? []) {
    if (validBar(b)) byTime.set(b.t, b);
  }
  let added = 0;
  for (const b of incoming ?? []) {
    if (!validBar(b)) continue;
    if (!byTime.has(b.t)) added++;
    byTime.set(b.t, b);
  }
  const bars = [...byTime.values()].sort((a, b) => a.t - b.t);
  return { bars, added, total: bars.length };
}

/**
 * How far back the stored history reaches, so a scheduled run can fetch only the
 * gap instead of the full window every time.
 *
 * Returns null for an absent or unreadable file, which the caller reads as "start
 * from scratch" — correct, and much cheaper than trying to repair it.
 */
export function lastBarTime(bars) {
  if (!Array.isArray(bars) || !bars.length) return null;
  const t = bars[bars.length - 1]?.t;
  return Number.isFinite(t) ? t : null;
}
/* ── the collector runner ─────────────────────────────────────────────────── */

const BN = "https://api.binance.com/api/v3";

function fileFor(pair, interval) {
  return path.join(config.dataDir, "history", "intraday", `${pair}-${interval}.json`);
}

function readBars(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? parsed : (parsed.bars ?? []);
  } catch {
    // Absent or unreadable: treated as "start from scratch" rather than an error,
    // so one corrupt file cannot stop collection for every other symbol.
    return [];
  }
}

/**
 * One collection pass over the universe.
 *
 * Failures are recorded per symbol and skipped rather than thrown: one delisted
 * pair must not stop the other eleven from collecting.
 *
 * Subsequent runs fetch only the gap since the last stored bar. A full re-fetch
 * every tick would be pure waste and would blow through the rate limit doing it.
 */
export async function collectOnce({ interval = "15m", bars = 2000, universe = INTRADAY_UNIVERSE, getJSON: fetch = getJSON } = {}) {
  const step = INTERVAL_MS[interval] ?? 900_000;
  const results = [];
  for (const pair of universe) {
    const file = fileFor(pair, interval);
    try {
      const existing = readBars(file);
      const last = lastBarTime(existing);
      const need = last ? Math.min(bars, Math.ceil((Date.now() - last) / step) + 20) : bars;
      const fresh = await fetchIntraday(pair, { interval, bars: Math.max(need, 10), getJSON: fetch, base: BN });
      const merged = mergeBars(existing, fresh);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ updated_at: new Date().toISOString(), bars: merged.bars }));
      results.push({ pair, added: merged.added, total: merged.total, ok: true });
    } catch (err) {
      results.push({ pair, added: 0, total: readBars(file).length, ok: false, error: err.message });
    }
  }
  return results;
}

/**
 * Start the collector on a timer.
 *
 * Hourly by default. Bars are 15-minute candles and the collector deliberately
 * drops the in-progress candle, so polling faster than that mostly re-reads
 * nothing and burns rate limit doing it.
 */
export function startIntradayCollector({ intervalMs = 3600_000, ...opts } = {}) {
  // Once at boot, so a fresh deployment has something to look at immediately
  // rather than being empty for the first hour.
  collectOnce(opts).catch(() => {});
  const timer = setInterval(() => collectOnce(opts).catch(() => {}), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}