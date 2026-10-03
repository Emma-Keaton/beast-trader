/**
 * Calibrate against the venue the app actually trades.
 *
 * Everything measured before this ran on *daily bars of large caps*, because that
 * was the only history that existed. The app trades 15-minute Solana long-tail
 * tokens, and those are not the same instrument. This module answers the question
 * the earlier research could not: on this venue, at this timeframe, is there
 * anything predictable, and can a trade even clear its costs here?
 *
 * The cost question comes first and is the more important half. A model can be
 * genuinely predictive and still be unprofitable because the move it predicts is
 * smaller than the spread. On thin long-tail pairs that is the usual situation,
 * and it is invisible in a hit rate.
 *
 * Reports are explicitly labelled with sample size, because 2,000 15-minute bars
 * across 8 pairs is about three weeks of history. It is enough to sanity-check the
 * assumptions and nowhere near enough to conclude anything about an edge. Treat
 * every number here as provisional until the collector has months of data.
 */

import fs from "node:fs";
import path from "node:path";

/** Bars per day at 15m, used to scale per-bar volatility to a daily figure. */
const BARS_PER_DAY = 96;

/**
 * Align several pairs on shared timestamps.
 *
 * Alignment rather than concatenation, because the pairs were listed on different
 * days. Concatenating would compare WIF's Friday against BONK's Monday and call
 */
export function alignSeries(dir, { limit = Infinity } = {}) {
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).slice(0, limit);
  } catch {
    // A missing directory is "nothing collected yet", not a crash. The
    // collector may simply not have run, and raising here would make a fresh
    // deployment look broken.
    return { series: [], pairs: 0, files: [] };
  }
  const byTime = new Map();
  let used = 0;
  for (const f of files) {
    let bars = [];
    try {
      bars = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")).bars ?? [];
    } catch {
      continue;
    }
    used++;
    for (const b of bars) {
      if (!Number.isFinite(b?.t) || !(Number(b.c) > 0)) continue;
      if (!byTime.has(b.t)) byTime.set(b.t, b.c);
    }
  }
  const series = [...byTime.entries()].sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  return { series, pairs: used, files };
}

/**
 * Does a trend-distance signal continue on this venue, at this timeframe?
 *
 * The same question the daily-bar study asked, re-run here. Measuring it twice on
 * two different instruments is the only way to know whether the daily-bar finding
 * transfers — and if it does not, everything built on the daily study needs
 * re-examining before it is trusted.
 *
 * `lookback` and `horizon` are both in bars, so the same code answers the 20-day
 * question and the 1-day question.
 */
export function continuationRate(rets, { lookback = 20, horizon = 96, minAbsZ = 0.5, step = 8 } = {}) {
  let same = 0;
  let total = 0;
  for (let i = lookback; i < rets.length - horizon; i += step) {
    const win = rets.slice(i - lookback, i);
    const m = win.reduce((s, r) => s + r, 0) / lookback;
    const v = win.reduce((s, r) => s + (r - m) ** 2, 0) / lookback;
    const sd = Math.sqrt(v);
    if (!(sd > 0)) continue;
    const z = (rets[i - 1] - m) / sd;
    if (Math.abs(z) < minAbsZ) continue;
    let fwd = 0;
    for (let j = i; j < i + horizon; j++) fwd += rets[j];
    // Direction agreement, not sign of return: what matters is whether being
    // above the mean predicts continuing up, which is the continuation claim.
    same += (z > 0) === (fwd > 0) ? 1 : 0;
    total++;
  }
  return total ? Number((same / total).toFixed(4)) : null;
}

/**
 * The full venue report.
 *
 * @param costBps round-trip cost assumption, matching the rest of the app
 */
export function venueReport(dir, { costBps = 34, limit = Infinity } = {}) {
  const { series, pairs } = alignSeries(dir, { limit });
  if (series.length < 50) {
    return { ok: false, why: `only ${series.length} aligned bars; need 50 before anything means anything` };
  }
  const rets = [];
  for (let i = 1; i < series.length; i++) rets.push(Math.log(series[i] / series[i - 1]));
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
  const sd = Math.sqrt(variance);
  const cost = costBps / 10_000;
  // The number that decides whether trading here is possible at all: how many
  // bars of expected move it takes to cover the round trip. Below 1 means a single
  // bar's worth of expected movement clears costs comfortably.
  const barsToClear = Math.ceil(Math.pow(cost / sd, 2));

  return {
    ok: true,
    pairs,
    bars: series.length,
    approxDays: Number((series.length / BARS_PER_DAY).toFixed(1)),
    perBarSd: Number((sd * 100).toFixed(4)),
    dailyEquivalentVol: Number((sd * Math.sqrt(BARS_PER_DAY) * 100).toFixed(2)),
    costBps,
    /** Cost as a fraction of one bar's volatility. */
    costInSd: Number((cost / sd).toFixed(2)),
    /** Bars of expected move needed to cover the round trip. */
    barsToClearCosts: barsToClear,
    continuation: {
      "20bar->1day": continuationRate(rets, { lookback: 20, horizon: 96 }),
      "96bar->1day": continuationRate(rets, { lookback: 96, horizon: 96 }),
      "96bar->4day": continuationRate(rets, { lookback: 96, horizon: 96 * 4 }),
    },
    note:
      series.length < BARS_PER_DAY * 21
        ? `PROVISIONAL: ${series.length} bars is under three weeks. Enough to sanity-check, nowhere near enough to conclude.`
        : "Sufficient history for a first read; still far short of a validated edge.",
  };
}
