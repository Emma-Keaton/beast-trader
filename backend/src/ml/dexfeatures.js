/**
 * DEX-derived model features.
 *
 * Two columns, appended after the base and cross-sectional features when a
 * `dex_snapshots` history exists:
 *
 *  - `liquidity_trend`     log change in pool liquidity versus the reference
 *                          point `REF_LAG_MS` earlier — is depth entering or
 *                          leaving the market this coin trades on?
 *  - `buy_sell_imbalance`  (buys − sells) / (buys + sells) in [−1, 1] — are
 *                          transactors hitting bids or lifting offers?
 *
 * Three properties make these safe to train on:
 *
 * 1. **Causal.** Both look up the newest snapshot at or before the bar's own
 *    timestamp (`latestAt`), never after. A bar can only see its own past.
 *
 * 2. **Neutral when nothing is observable.** No index, no symbol, no snapshot
 *    before the bar, or a collector that stalled more than `MAX_SNAPSHOT_AGE_MS`
 *    ago all return `DEX_NEUTRAL = [0, 0]`. Zero is a true neutral point for
 *    both quantities (no liquidity change; equal buys and sells), and — this is
 *    the part that matters — the live scoring path pads a missing column with
 *    raw zero too, so training and production treat an unobserved DEX state
 *    identically instead of drifting apart.
 *
 * 3. **Width is decided by coverage, not by hope.** `buildUniverseDataset`
 *    strips these columns again when too few rows were actually observed (see
 *    `minDexCoverage` there), so a mostly-empty snapshot history can never
 *    produce a model whose DEX features are 95% padding.
 */

/** Names appended after base+xs features; recorded verbatim in the model file. */
export const DEX_FEATURE_NAMES = [
  "liquidity_trend", // log(liquidity_now / liquidity_ref), clamped
  "buy_sell_imbalance", // (buys - sells) / (buys + sells), in [-1, 1]
];

/** Raw values used when nothing is observable. Both are true neutral points. */
export const DEX_NEUTRAL = [0, 0];

/** How far back `liquidity_trend` looks for its reference snapshot. */
export const REF_LAG_MS = 6 * 3600_000;

/**
 * A snapshot older than this relative to the bar does not describe the bar.
 *
 * The collector ticks about once a minute per chain; two days without a row
 * means it stopped, was budget-starved, or the table was never filled. Treating
 * that stale reading as current state would attach a confident DEX feature to
 * every recent bar, so the row falls back to neutral and reports unobserved —
 * which is what the coverage floor is there to notice.
 */
export const MAX_SNAPSHOT_AGE_MS = 48 * 3600_000;

/** Sanity clamp on the liquidity log-ratio (~20x in 6h is a data error). */
const TREND_CLAMP = 3;

/**
 * Group raw `dex_snapshots` rows into a per-symbol, time-ordered index.
 *
 * Unsorted input, ISO timestamps and malformed rows are all expected here:
 * this reads whatever the collector (or a test) produced, and one bad row must
 * not poison the series. Returns `Map<symbol, [{ts, liq, buys, sells}...]>`.
 */
export function buildDexIndex(snapshots) {
  const bySymbol = new Map();
  for (const s of Array.isArray(snapshots) ? snapshots : []) {
    if (!s || typeof s.symbol !== "string" || !s.symbol) continue;
    const ts = typeof s.ts === "number" ? s.ts : Date.parse(s.ts);
    if (!Number.isFinite(ts)) continue;
    const rec = {
      ts,
      liq: finiteOrNull(s.liquidity_usd),
      buys: finiteOrNull(s.buys),
      sells: finiteOrNull(s.sells),
    };
    const list = bySymbol.get(s.symbol);
    if (list) list.push(rec);
    else bySymbol.set(s.symbol, [rec]);
  }
  for (const list of bySymbol.values()) list.sort((a, b) => a.ts - b.ts);
  return bySymbol;
}

/**
 * The two DEX values for one (symbol, bar timestamp) pair.
 *
 * @returns `{ values: [trend, imbalance], observed }`. `observed: false` means
 * no usable snapshot described this bar — `values` is then `DEX_NEUTRAL`.
 */
export function dexValuesFor(index, symbol, ts) {
  if (!index || typeof index.get !== "function") return { values: DEX_NEUTRAL, observed: false };
  const list = index.get(symbol);
  if (!list || !list.length) return { values: DEX_NEUTRAL, observed: false };

  const t = typeof ts === "number" ? ts : Date.parse(ts);
  if (!Number.isFinite(t)) return { values: DEX_NEUTRAL, observed: false };

  const cur = latestAt(list, t);
  if (!cur) return { values: DEX_NEUTRAL, observed: false };
  if (t - cur.ts > MAX_SNAPSHOT_AGE_MS) return { values: DEX_NEUTRAL, observed: false };

  // Liquidity trend versus the reference point. A missing reference (the
  // collector only started REF_LAG_MS ago, or both lookups land on the same
  // snapshot) means "no observable change", which is zero — not an excuse to
  // mark the row unobserved, because the imbalance below may still be real.
  let trend = 0;
  const ref = latestAt(list, t - REF_LAG_MS);
  if (ref && ref !== cur && Number.isFinite(cur.liq) && Number.isFinite(ref.liq) && cur.liq > 0 && ref.liq > 0) {
    trend = Math.max(-TREND_CLAMP, Math.min(TREND_CLAMP, Math.log(cur.liq / ref.liq)));
  }

  let imbalance = 0;
  if (Number.isFinite(cur.buys) && Number.isFinite(cur.sells) && cur.buys + cur.sells > 0) {
    imbalance = (cur.buys - cur.sells) / (cur.buys + cur.sells);
  }

  return { values: [trend, imbalance], observed: true };
}

/** Newest record with `record.ts <= ts`, via binary search. Null when none. */
function latestAt(list, ts) {
  let lo = 0;
  let hi = list.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].ts <= ts) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans >= 0 ? list[ans] : null;
}

function finiteOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}