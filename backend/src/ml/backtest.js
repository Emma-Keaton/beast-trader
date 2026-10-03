/**
 * Walk-forward backtester.
 *
 * This is the only honest way to judge a trading model: train on the past,
 * trade the future, repeat. A single train/test split wastes data and a random
 * split leaks the future into the past. Here the data is walked forward in
 * time and every prediction is made by a model that had never seen that
 * region of the timeline.
 *
 * Realistic costs are modelled because a strategy that only works at zero fee
 * is not a strategy:
 *   - taker fee on entry *and* exit (0.1% default, Binance-spot-like)
 *   - slippage on entry and exit (0.05% default)
 *   - both sides of a short are charged, as on a real venue
 * Positions are always closed before the last bar, so no trade is left
 * open-ended at the end of the sample.
 */

import { buildDataset, classificationMetrics } from "./dataset.js";
import { fit, predictProbability } from "./logistic.js";
import { combinatorialPurgedCV, makeEvent, reconstructPath } from "./purged.js";
import { returnMoments, deflatedSharpeRatio, effectiveTrials } from "./stats.js";

const DEFAULTS = {
  horizon: 3,
  feePct: 0.001,
  slippagePct: 0.0005,
  minConfidence: 0.55, // below this we stay flat — real money sits idle
  folds: 4,
  groups: 6, // CPCV groups
  epochs: 300,
};

/**
 * @param bars   OHLCV series, oldest first
 * @param opts   see DEFAULTS; `baseline` adds an always-long control group
 * @returns report with classification metrics, trade stats and fold detail
 */
export function backtest(bars, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  if (!Array.isArray(bars) || bars.length < 80) {
    return { ok: false, reason: "not enough history to test" };
  }

  const { X, y, indices } = buildDataset(bars, cfg);
  if (X.length < 60) {
    return { ok: false, reason: "not enough clean training rows", rows: X.length };
  }

  // Chronological folds: each test block sits strictly after its train block.
  const foldSize = Math.floor(X.length / (cfg.folds + 1));
  const trades = [];
  const probs = [];
  const labels = [];
  const folds = [];
  // Per-fold return series, used as the trial set for the DSR.
  const foldReturns = [];

  for (let f = 0; f < cfg.folds; f++) {
    const trainEnd = foldSize * (f + 1);
    const testStart = trainEnd;
    const testEnd = Math.min(X.length, trainEnd + foldSize);
    if (testEnd - testStart < 5) break;

    const model = fit(X.slice(0, trainEnd), y.slice(0, trainEnd), { epochs: cfg.epochs });
    const foldProbs = [];
    const foldLabels = [];

    for (let i = testStart; i < testEnd; i++) {
      const p = predictProbability(model, X[i]);
      probs.push(p);
      labels.push(y[i]);
      foldProbs.push(p);
      foldLabels.push(y[i]);

      const trade = simulateTrade(bars, indices[i], p, cfg);
      if (trade) {
        trades.push(trade);
        foldReturns.push(trade.netReturn);
      }
    }
    folds.push({
      fold: f + 1,
      trainRows: trainEnd,
      testRows: testEnd - testStart,
      ...classificationMetrics(foldProbs, foldLabels),
    });
  }

  const metrics = classificationMetrics(probs, labels);
  const stats = tradeStats(trades);

  // Walk-forward folds are cheap and familiar, but they still leak: a training
  // row's 3-day label window reaches into the test block. CPCV purges those
  // rows properly and produces a stability estimate, which is the number that
  // decides whether this model is trustworthy.
  const events = indices.map((i) => makeEvent(i, cfg.horizon));
  const cpcv = combinatorialPurgedCV(events, cfg.groups ?? 6, 2, cfg.horizon);
  const returnsByIndex = new Map();
  for (let k = 0; k < indices.length; k++) {
    returnsByIndex.set(indices[k], probs[k] >= 0.5 ? 1 : -1);
  }
  const path = reconstructPath(cpcv, returnsByIndex);

  // Every fold is a configuration this run effectively "chose" between, and
  // we picked the best-looking aggregate. Feeding the per-fold Sharpes to the
  // DSR is what stops that selection from being mistaken for skill.
  const moments = foldReturns.filter((r) => r.length >= 4).map((r) => returnMoments(r));
  const trialSharpes = moments.map((m) => m.sharpe);
  const nEff = trialSharpes.length >= 2 ? effectiveTrials(foldReturns) : 1;
  const selected = moments.length ? moments.reduce((best, m) => (m.sharpe > best.sharpe ? m : best)) : null;
  const dsr = selected
    ? deflatedSharpeRatio(selected.sharpe, trialSharpes, selected.T, selected.skewness, selected.kurtosis)
    : null;

  return {
    ok: true,
    model: "logistic-v2",
    horizon: cfg.horizon,
    samples: metrics.samples,
    accuracy: metrics.accuracy,
    precision: metrics.precision,
    recall: metrics.recall,
    f1: metrics.f1,
    brier: metrics.brier,
    base_rate: metrics.up_rate,
    trades: stats,
    folds,
    // Statistical significance, not just "is the average positive".
    significance: dsr
      ? {
          deflated_sharpe: dsr.dsr,
          // The Sharpe the best of N lucky strategies would reach by chance.
          expected_max_sharpe: dsr.expectedMaxSR,
          effective_trials: nEff,
          sharpe: moments.sharpe,
          observations: moments.T,
          // The best fold's Sharpe, and the probability it beats the
          // luckiest-of-N hurdle. Below 0.95 we do not call it real.
          significant: dsr.dsr >= 0.95,
        }
      : null,
    cpcv: { splits: cpcv.length, path_points: path.length },
    config: cfg,
  };
}

/**
 * Decide a position for one bar and simulate it to its exit.
 * Returns null when the model is not confident enough to act.
 */
export function simulateTrade(bars, i, p, cfg) {
  // `minConfidence` lives on the same 0.5..1 scale as p, so the tradeable
  // bands are [minConfidence, 1] for longs and [0, 1-minConfidence] for
  // shorts. Anything between the two is "not sure enough" => stay flat.
  const dir = p >= cfg.minConfidence ? 1 : p <= 1 - cfg.minConfidence ? -1 : 0;
  if (dir === 0) return null;
  const confidence = Math.abs(p - 0.5) * 2; // 0..1 distance from a coin flip

  const entryBar = i + 1; // decision on the close, fill on the next bar
  const exitBar = i + cfg.horizon;
  if (exitBar >= bars.length) return null; // no data to close against

  const fill = (px) => px * (1 + (dir > 0 ? cfg.slippagePct : -cfg.slippagePct));
  const entry = fill(bars[entryBar].c);
  const exit = fill(bars[exitBar].c);

  const gross = dir > 0 ? (exit - entry) / entry : (entry - exit) / entry;
  // Fees on both sides: an exit is a sell for a long, a buy for a short.
  const net = gross - cfg.feePct * 2;

  return {
    entryBar,
    exitBar,
    t: bars[exitBar].t,
    side: dir > 0 ? "LONG" : "SHORT",
    entryPrice: entry,
    exitPrice: exit,
    confidence: Number(confidence.toFixed(3)),
    grossReturn: gross,
    netReturn: net,
    won: net > 0,
  };
}

/** Aggregate P&L, win rate, profit factor and max drawdown for the trade list. */
export function tradeStats(trades) {
  if (!trades.length) {
    return { count: 0, winRate: 0, avgReturn: 0, profitFactor: 0, totalReturn: 0, maxDrawdown: 0, expectancy: 0 };
  }
  let wins = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let sum = 0;
  const sorted = [...trades].sort((a, b) => a.exitBar - b.exitBar);
  let equity = 1;
  let peak = 1;
  let maxDD = 0;

  for (const t of sorted) {
    sum += t.netReturn;
    if (t.won) {
      wins++;
      grossProfit += t.netReturn;
    } else {
      grossLoss += Math.abs(t.netReturn);
    }
    // Trades are treated as sequential full-notional positions for equity,
    // which is how the account would actually compound.
    equity *= 1 + t.netReturn;
    peak = Math.max(peak, equity);
    maxDD = Math.max(maxDD, (peak - equity) / peak);
  }

  const avgReturn = sum / trades.length;
  return {
    count: trades.length,
    winRate: wins / trades.length,
    avgReturn,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    totalReturn: equity - 1,
    maxDrawdown: maxDD,
    // Expectancy per trade: the number that decides if this is worth running.
    expectancy: avgReturn,
  };
}
