/**
 * Cross-sectional (market-relative) features.
 *
 * The most important result in this area is Liu, Tsyvinski & Wu, "Common Risk
 * Factors in Cryptocurrency" (Journal of Finance, 2022). Their three-factor
 * model — **market, size and momentum** — is what captures cross-sectional
 * expected crypto returns, and every strategy they test is accounted for by it.
 *
 * The practical consequence: the predictable signal is mostly *relative*. "This
 * coin will go up" is close to unpredictable; "this coin will go up more than
 * the rest of the market" is what the literature supports. A model trained on
 * raw time-series features is largely learning the market's own direction,
 * which is precisely the thing no single coin can forecast.
 *
 * So each coin's features are expressed *relative to the equal-weighted market
 * at the same timestamp*, plus cross-sectional ranks. The original time-series
 * features are kept alongside: a coin that is weak and falling relative to the
 * market is a different signal from one that is weak but holding up, and the
 * model needs both to tell them apart.
 *
 * Everything is causal — the market factor at bar `t` uses only bars up to `t`.
 */

import { buildFeatures, logReturns, rollingStd } from "./features.js";

/** Features this module adds. The model file records the full list. */
export const XS_FEATURE_NAMES = [
  "rel_ret_1", // own last-bar move, minus the market's
  "rel_ret_5", // 5-bar move relative to the market's
  "rel_sma_gap_20", // own trend gap minus the market's
  "xs_mom_rank", // percentile rank of 20-bar momentum in the cross-section
  "xs_vol_rank", // percentile rank of 20-bar volatility
  "beta_resid", // last-bar move after removing market beta
];

/**
 * The equal-weighted market series.
 *
 * Bars are matched by **timestamp, not position** — coins list at different
 * times, and a positional alignment would compare a Bitcoin bar from 2021 to a
 * Solana bar from 2024, which looks like data but is a timestamp mismatch.
 *
 * Returns a synthetic price index so ordinary features (momentum, SMA gap)
 * can be computed from it exactly as they are for a real coin.
 */
export function buildMarketSeries(universe) {
  const retByTs = new Map();
  for (const { bars } of universe) {
    for (let i = 1; i < bars.length; i++) {
      if (bars[i - 1].c <= 0) continue;
      const t = bars[i].t;
      if (!retByTs.has(t)) retByTs.set(t, []);
      retByTs.get(t).push(Math.log(bars[i].c / bars[i - 1].c));
    }
  }

  const timestamps = [...retByTs.keys()].sort((a, b) => a - b);
  const marketRet = timestamps.map((t) => {
    const rs = retByTs.get(t);
    return rs.reduce((s, r) => s + r, 0) / rs.length;
  });

  // A synthetic price index: exp(cumulative market return). Lets the same
  // rolling-window helpers used on real coins work here unchanged.
  const closes = [1];
  for (const r of marketRet) closes.push(closes[closes.length - 1] * Math.exp(r));
  return { timestamps, marketRet, closes, retByTs };
}

/** Percentile rank of `value` within `all`, in 0..1. */
function rankOf(all, value) {
  if (all.length < 2) return 0.5;
  let below = 0;
  for (const v of all) if (v < value) below++;
  return below / (all.length - 1);
}

/**
 * Build cross-sectional feature rows, one per (timestamp, coin).
 *
 * A timestamp is only usable with at least `minCross` coins trading, because
 * a "cross-section" of two coins has no meaningful ranks in it.
 */
export function buildCrossSectional(universe, { minCross = 5, lookback = 20 } = {}) {
  const market = buildMarketSeries(universe);
  const marketAt = new Map(market.timestamps.map((t, i) => [t, i]));

  // Per-coin time-series features, indexed by timestamp.
  const coins = universe.map(({ symbol, bars }) => {
    const { features, indices } = buildFeatures(bars);
    const byTs = new Map();
    for (let k = 0; k < features.length; k++) {
      const i = indices[k];
      byTs.set(bars[i].t, { f: features[k], i });
    }
    return {
      symbol,
      byTs,
      closes: bars.map((b) => b.c),
      rets: logReturns(bars.map((b) => b.c)),
    };
  });

  const out = [];
  // Rolling windows are maintained incrementally. Slicing the close array for
  // every (timestamp, coin) pair makes this O(n^2) — with 3,300 bars and 12
  // coins that is ~130M operations plus an allocation for each one, which took
  // the trainer from seconds to minutes.
  const win = new Map(); // symbol -> rolling sum of closes over `lookback`
  let mktSum = 0; // rolling sum of market closes over `lookback`

  for (let m = 0; m < market.timestamps.length; m++) {
    const ts = market.timestamps[m];
    if (marketAt.get(ts) !== m) continue; // never happens; guards the loop
    const live = coins.filter((c) => c.byTs.has(ts));
    if (live.length < minCross || m < lookback) continue;

    mktSum += market.closes[m + 1];
    if (m >= lookback) mktSum -= market.closes[m - lookback];
    const mktSma = mktSum / lookback;
    const mktGap = mktSma > 0 ? market.closes[m + 1] / mktSma - 1 : 0;
    const mktMom = Math.log(market.closes[m + 1] / market.closes[m + 1 - lookback] || 1);
    const mkt1 = market.marketRet[m] ?? 0;

    for (const c of live) {
      const i = c.byTs.get(ts).i;
      const prev = win.get(c.symbol) ?? 0;
      const s = i >= lookback ? prev + c.closes[i] - c.closes[i - lookback] : prev + c.closes[i];
      win.set(c.symbol, s);
      c.rollingSma = s / lookback;
    }

    const mom = live.map((c) => {
      const i = c.byTs.get(ts).i;
      return i >= lookback && c.closes[i - lookback] > 0 ? Math.log(c.closes[i] / c.closes[i - lookback]) : 0;
    });
    const vol = live.map((c) => rollingStd(c.rets, c.byTs.get(ts).i, 20) ?? 0);

    for (let k = 0; k < live.length; k++) {
      const c = live[k];
      const { f, i } = c.byTs.get(ts);
      const own1 = c.rets[i] ?? 0;
      const beta = rollingBeta(c.rets, i, market, m, lookback);
      const ownGap = c.rollingSma > 0 ? c.closes[i] / c.rollingSma - 1 : 0;
      out.push({
        ts,
        symbol: c.symbol,
        index: i,
        base: f,
        xs: [
          safe(own1 - mkt1),
          safe(mom[k] - mktMom),
          safe(ownGap - mktGap),
          safe(rankOf(mom, mom[k])),
          safe(rankOf(vol, vol[k])),
          safe(own1 - beta * mkt1),
        ],
      });
    }
  }
  return { rows: out, market };
}

/**
 * Rolling beta of one coin to the market.
 *
 * Both series are matched through the market's timestamp ordering, which is the
 * only alignment that means anything when coins trade on different days.
 */
function rollingBeta(rets, i, market, m, n) {
  const ownStart = Math.max(0, i - (m - Math.max(0, m - n + 1)));
  const own = rets.slice(ownStart, i + 1);
  const mkt = market.marketRet.slice(Math.max(0, m - n + 1), m + 1);
  const len = Math.min(own.length, mkt.length);
  if (len < 2) return 1;

  const o = own.slice(-len);
  const k = mkt.slice(-len);
  const meanO = meanOf(o);
  const meanK = meanOf(k);
  let cov = 0;
  let varK = 0;
  for (let j = 0; j < len; j++) {
    cov += (o[j] - meanO) * (k[j] - meanK);
    varK += (k[j] - meanK) ** 2;
  }
  // A near-zero market variance would produce an infinite beta, so fall back
  // to 1 (the market itself) rather than emit a wild residual.
  if (varK <= 1e-12) return 1;
  return Math.max(0.1, Math.min(3, cov / varK));
}

function meanOf(a) {
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
}

/** NaN/Inf guard: the model must never see a non-finite number. */
function safe(x) {
  return Number.isFinite(x) ? x : 0;
}

