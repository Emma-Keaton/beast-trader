// Research harness: is there ANY predictive signal in the data this app holds?
//
// Data is DAILY bars, 2017-2026, large-cap coins. Stated up front because it
// matters: this is NOT the universe the app trades (Solana long-tail, 30m bars).
// Anything found here is evidence about crypto, not proof about the venue.
//
//   A. cross-sectional IC  - does a signal rank tomorrow's winners?
//   B. time-series direction - does anything predict one coin's next move?
//   C. volatility - predictable even when direction is not?
//   D. why the ensemble's confidence came out ANTI-correlated with accuracy
//   E. the app's actual premise: is "buy the top gainers" better than "buy everything"?
//   F. does any of it survive costs?
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HIST_DIR = path.join(ROOT, "data", "history");
const HORIZONS = [1, 3, 7, 14, 30];
const COST = 34 / 10000; // 34bps round trip: ~10bps slippage + ~7bps fee, both legs

function loadCoins() {
  const out = [];
  for (const f of fs.readdirSync(HIST_DIR).filter((x) => x.endsWith(".json"))) {
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(HIST_DIR, f), "utf8")); } catch { continue; }
    if (!Array.isArray(j.bars) || j.bars.length < 200) continue;
    const bars = j.bars.filter((b) => b && b.c > 0 && b.h >= b.l && b.o > 0 && b.l > 0);
    bars.sort((a, b) => a.t - b.t);
    if (bars.length < 200) continue;
    // Daily only - anything else would silently mix timeframes.
    const gaps = bars.slice(1, 40).map((b, i) => b.t - bars[i].t).sort((a, b) => a - b);
    if (gaps[Math.floor(gaps.length / 2)] !== 86400000) continue;
    out.push({ sym: j.symbol, id: j.id, t: bars.map((b) => b.t), c: bars.map((b) => b.c), h: bars.map((b) => b.h), l: bars.map((b) => b.l) });
  }
  // Duplicate symbols exist (bitcoin/BTC, ethereum/ETH, solana/SOL). Keep the
  // longest per symbol so the cross-section is not double-counted.
  const best = new Map();
  for (const s of out) { const cur = best.get(s.sym); if (!cur || s.c.length > cur.c.length) best.set(s.sym, s); }
  return [...best.values()].sort((a, b) => b.c.length - a.c.length);
}

const rank = (a) => {
  const idx = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]).map(([, i]) => i);
  const out = new Array(a.length);
  idx.forEach((orig, pos) => { out[orig] = pos + 1; });
  return out;
};
const spearman = (a, b) => {
  if (a.length < 5) return null;
  const ra = rank(a), rb = rank(b);
  const mn = (x) => x.reduce((p, c) => p + c, 0) / x.length;
  const ma = mn(ra), mb = mn(rb);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < ra.length; i++) { const xa = ra[i] - ma, xb = rb[i] - mb; num += xa * xb; da += xa * xa; db += xb * xb; }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : null;
};
const mean = (x) => x.reduce((p, c) => p + c, 0) / x.length;
const std = (x) => { const m = mean(x); return Math.sqrt(x.reduce((p, c) => p + (c - m) ** 2, 0) / Math.max(1, x.length - 1)); };
// t-stat discounted for overlapping forward windows, so it reads conservative.
const tDisc = (v, h) => { const nEff = Math.max(2, Math.floor(v.length / h)); return mean(v) / ((std(v) || 1e-9) / Math.sqrt(nEff)); };

// Signals use only information available AT index i.
const SIG = {
  mom1: (s, i) => s.c[i] / s.c[i - 1] - 1,
  mom7: (s, i) => s.c[i] / s.c[i - 7] - 1,
  mom14: (s, i) => s.c[i] / s.c[i - 14] - 1,
  mom30: (s, i) => s.c[i] / s.c[i - 30] - 1,
  mom90: (s, i) => s.c[i] / s.c[i - 90] - 1,
  rev1: (s, i) => -(s.c[i] / s.c[i - 1] - 1),
  rev7: (s, i) => -(s.c[i] / s.c[i - 7] - 1),
  // sigma distance from the 20-day mean: "how far has it run". The feature the
  // Holt-Winters ensemble leans hardest on, isolated so it can be judged alone.
  dev20: (s, i) => { const w = s.c.slice(i - 20, i + 1); return (s.c[i] - mean(w)) / (std(w) || 1); },
  rng30: (s, i) => {
    const w = s.c.slice(i - 30, i + 1);
    const hi = Math.max(...w), lo = Math.min(...w);
    return (s.c[i] - lo) / ((hi - lo) || 1) - 0.5;
  },
};

function main() {
  const coins = loadCoins();
  console.log(coins.length + " coins after dedupe/clean: " + coins.map((c) => c.sym).join(", "));
  console.log("universe = LARGE CAPS. The app forecasts the same DAILY timeframe but on");
  console.log("Solana long-tail tokens - same timeframe, different universe.\n");

  const dates = [...new Set(coins.flatMap((c) => c.t))].sort((a, b) => a - b);
  const dIdx = new Map(dates.map((t, i) => [t, i]));
  const D = dates.length;
  const S = coins.map((c) => {
    const o = { sym: c.sym, c: new Array(D).fill(null), h: new Array(D).fill(null), l: new Array(D).fill(null) };
    for (let k = 0; k < c.t.length; k++) { const i = dIdx.get(c.t[k]); o.c[i] = c.c[k]; o.h[i] = c.h[k]; o.l[i] = c.l[k]; }
    return o;
  });
  console.log(D + " aligned trading days = " + (D / 365.25).toFixed(1) + " years\n");

  const fwd = (s, i, h) => (s.c[i] && s.c[i + h] ? s.c[i + h] / s.c[i] - 1 : null);
  const okAt = (s, i, lb) => s.c[i] != null && s.c[i - lb] != null && s.c[i - lb] > 0;

  console.log("=== A. CROSS-SECTIONAL IC (does the signal rank tomorrow's winners?) ===");
  console.log("| signal | " + HORIZONS.map((h) => "h=" + h + "d").join(" | ") + " |");
  console.log("|---|" + HORIZONS.map(() => "---").join("|") + "|");
  for (const [name, fn] of Object.entries(SIG)) {
    const cells = [];
    for (const h of HORIZONS) {
      const per = [];
      for (let i = 95; i < D - h; i++) {
        const sv = [], rv = [];
        for (const s of S) {
          if (!okAt(s, i, 90)) continue;
          const fr = fwd(s, i, h), sig = fn(s, i);
          if (fr === null || !Number.isFinite(fr) || !Number.isFinite(sig)) continue;
          sv.push(sig); rv.push(fr);
        }
        const ic = spearman(sv, rv);
        if (ic !== null) per.push(ic);
      }
      if (per.length < 30) { cells.push("n/a"); continue; }
      const m = mean(per), t = tDisc(per, h);
      cells.push((m >= 0 ? "+" : "") + m.toFixed(3) + " (t" + (t >= 0 ? "+" : "") + t.toFixed(1) + ")");
    }
    console.log("| " + name + " | " + cells.join(" | ") + " |");
  }
  console.log("\n|IC| 0.03 is a real signal, 0.05 strong. t-stats already discounted for overlap.");

  console.log("\n=== B. TIME-SERIES DIRECTION (the question the ensemble actually faces) ===");
  console.log("| signal | " + HORIZONS.map((h) => "h=" + h + "d").join(" | ") + " |");
  console.log("|---|" + HORIZONS.map(() => "---").join("|") + "|");
  for (const [name, fn] of Object.entries(SIG)) {
    const cells = [];
    for (const h of HORIZONS) {
      let hit = 0, n = 0;
      for (const s of S) {
        for (let i = 95; i < D - h; i++) {
          if (!okAt(s, i, 90)) continue;
          const fr = fwd(s, i, h), sig = fn(s, i);
          if (fr === null || !Number.isFinite(sig) || Math.abs(sig) < 1e-9) continue;
          n++;
          if (Math.sign(sig) === Math.sign(fr)) hit++;
        }
      }
      cells.push(n ? (100 * hit / n).toFixed(1) + "%" : "n/a");
    }
    console.log("| " + name + " | " + cells.join(" | ") + " |");
  }
  console.log("\n50% is a coin flip. Under 50% is not 'wrong', it is an inverted signal - and");
  console.log("inverting a backtested signal is how overfitting is born.");

  console.log("\n=== C. VOLATILITY PREDICTABILITY (direction may be unknowable; risk is not) ===");
  for (const h of [1, 7, 30]) {
    const a = [], b = [];
    for (const s of S) {
      for (let i = 1; i < D - h; i++) {
        if (!okAt(s, i, 1)) continue;
        const p = Math.abs(s.c[i] / s.c[i - 1] - 1), nx = Math.abs(fwd(s, i, h) ?? NaN);
        if (!Number.isFinite(p) || !Number.isFinite(nx)) continue;
        a.push(p); b.push(nx);
      }
    }
    const ic = spearman(a, b);
    console.log("  |1-day move| -> |next " + String(h).padEnd(2) + "d|   IC " + (ic === null ? "n/a" : ic.toFixed(3)));
  }

  console.log("\n=== D. WHY CONFIDENCE WAS ANTI-CORRELATED WITH ACCURACY ===");
  console.log("When price sits far from its 20-day mean, a trend model shouts 'continue'.");
  console.log("Does it continue, or reverse?\n");
  for (const h of [7, 30]) {
    console.log("  horizon " + h + "d");
    for (const b of [[0, 0.5], [0.5, 1], [1, 2], [2, 99]]) {
      const hits = [];
      for (const s of S) {
        for (let i = 95; i < D - h; i++) {
          if (!okAt(s, i, 90)) continue;
          const d = SIG.dev20(s, i), fr = fwd(s, i, h);
          if (!Number.isFinite(d) || fr === null || Math.abs(d) < b[0] || Math.abs(d) >= b[1]) continue;
          hits.push(Math.sign(d) === Math.sign(fr) ? 1 : 0);
        }
      }
      if (hits.length < 30) continue;
      console.log("    |dev20| " + b[0] + "-" + (b[1] === 99 ? "+" : b[1]) + " sigma   continues " + mean(hits).toFixed(3) + "  (n=" + hits.length + ")");
    }
  }
  console.log("\nBelow 0.50 means the further it has run, the more often it reverses - exactly");
  console.log("the regime where a trend-extrapolating model is most confident. Hence confidence");
  console.log("that points the wrong way.");

  console.log("\n=== E. THE APP'S PREMISE: 'buy the top gainers' IS cross-sectional momentum ===");
  console.log("Long the top-N coins by trailing return, equal weight, hold h days.");
  console.log("Benchmark = equal-weight the whole board over the same days.\n");
  console.log("| lookback | hold | N | gross | net | benchmark | net-bench | t |");
  console.log("|---|---|---|---|---|---|---|---|");
  for (const lb of [7, 30]) {
    for (const h of [7, 14, 30]) {
      for (const N of [2, 3]) {
        const net = [], bench = [];
        for (let i = lb + 5; i < D - h; i++) {
          const live = [];
          for (let k = 0; k < S.length; k++) {
            if (!okAt(S[k], i, lb) || fwd(S[k], i, h) === null) continue;
            live.push({ past: S[k].c[i] / S[k].c[i - lb] - 1, fr: fwd(S[k], i, h) });
          }
          if (live.length < Math.max(6, N * 2)) continue;
          live.sort((a, b) => b.past - a.past);
          net.push(mean(live.slice(0, N).map((x) => x.fr)) - COST);
          bench.push(mean(live.map((x) => x.fr)));
        }
        if (net.length < 30) continue;
        const excess = net.map((v, i2) => v - bench[i2]);
        const t = tDisc(excess, h), nm = mean(net), bm = mean(bench);
        console.log("| " + lb + "d | " + h + "d | " + N + " | " + ((nm + COST) * 100).toFixed(2) + "% | " + (nm >= 0 ? "+" : "") + (nm * 100).toFixed(2) + "% | " + (bm >= 0 ? "+" : "") + (bm * 100).toFixed(2) + "% | " + (nm - bm >= 0 ? "+" : "") + ((nm - bm) * 100).toFixed(2) + "% | " + (t >= 0 ? "+" : "") + t.toFixed(1) + " |");
      }
    }
  }
  console.log("\nBeating the equal-weight basket is the only thing that matters here. If 'buy the");
  console.log("top gainers' does not beat 'buy everything', the app pays costs for a bet the");
  console.log("user could make by holding the whole board.");

  console.log("\n=== F. NET OF COSTS, per-coin signals (34bps round trip) ===");
  console.log("| signal | hold | gross | net | t |");
  console.log("|---|---|---|---|---|");
  for (const r of [["mom1", 7], ["mom7", 7], ["mom30", 30], ["rev1", 7], ["rev7", 14], ["dev20", 7], ["dev20", 30], ["mom90", 30]]) {
    const fn = SIG[r[0]], h = r[1], gross = [], net = [];
    for (const s of S) {
      for (let i = 95; i < D - h; i++) {
        if (!okAt(s, i, 90)) continue;
        const sig = fn(s, i), fr = fwd(s, i, h);
        if (!Number.isFinite(sig) || fr === null || Math.abs(sig) < 1e-9) continue;
        const g = Math.sign(sig) * fr;
        gross.push(g); net.push(g - COST);
      }
    }
    if (!gross.length) continue;
    console.log("| " + r[0] + " | " + h + "d | " + (mean(gross) * 100).toFixed(3) + "% | " + (mean(net) * 100).toFixed(3) + "% | " + (tDisc(net, h) >= 0 ? "+" : "") + tDisc(net, h).toFixed(1) + " |");
  }
  console.log("\nAnything not net-positive after costs is not a strategy, however good its hit rate.");
}
main();
