/**
 * Measures how far `rsi()` in features.js sits from a true Wilder RSI.
 * Diagnostic only — not imported by the app or the test suite.
 * Run: node scripts/rsi-compare.js
 */
import fs from "node:fs";
import path from "node:path";
import { rsi } from "../src/ml/features.js";

/**
 * Textbook Wilder over the FULL series, evaluated at `end`.
 *
 * The smoothing loop must run from index 1 up to `end` — it cannot be skipped,
 * or this degenerates into the simple average it is supposed to be compared
 * against. An earlier version sliced the series to `end + 1` before calling it,
 * which left the loop empty and reported a diff of 0.0000 on every symbol. That
 * is the exact shape of a guard that manufactures false confidence: it agreed
 * with the thing it was meant to check.
 */
function wilder(closes, end, n = 14) {
  if (end < n) return null;
  // Seed with a simple average over the first n bars, then smooth forward with
  // alpha = 1/n through the WHOLE history. Seeding at `end - n` and smoothing to
  // `end` would measure the same 14 bars twice; the seed has to start at the
  // series start for these values to be comparable with a library implementation.
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= end; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    if (i <= n) {
      avgGain += g;
      avgLoss += l;
      if (i === n) {
        avgGain /= n;
        avgLoss /= n;
      }
    } else {
      avgGain = (avgGain * (n - 1) + g) / n;
      avgLoss = (avgLoss * (n - 1) + l) / n;
    }
  }
  if (avgLoss === 0) return 1;
  const rs = avgGain / avgLoss;
  return rs / (1 + rs);
}

const dir = path.join(process.cwd(), "data", "history");
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));

for (const f of files) {
  const parsed = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
  // History files are `{ id, symbol, bars, source, fetchedAt }`, not a bare array.
  const bars = Array.isArray(parsed) ? parsed : parsed.bars;
  if (!Array.isArray(bars)) continue;
  const closes = bars.map((b) => b.c).filter((c) => Number.isFinite(c) && c > 0);
  if (closes.length < 60) continue;

  // Compare at several horizons so we see convergence, not one lucky point.
  for (const end of [closes.length - 1, closes.length - 20, closes.length - 60]) {
    const ours = rsi(closes, end, 14);
    const ref = wilder(closes.slice(0, end + 1), end, 14);
    if (ours == null || ref == null) continue;
    console.log(
      `${f.padEnd(22)} bars=${String(closes.length).padStart(5)} ` +
        `ours=${ours.toFixed(4)} wilder=${ref.toFixed(4)} diff=${(ours - ref).toFixed(4)}`,
    );
  }
}