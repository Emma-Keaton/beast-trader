/**
 * Out-of-sample evaluation of the *cross-sectional* model.
 *
 * The per-coin backtest in `backtest.js` reports metrics for a different,
 * single-coin model. Quoting those numbers next to a cross-sectionally-trained
 * model would describe a system that is not the one shipping, so the
 * cross-sectional model gets its own honest evaluation.
 *
 * Method:
 *  - **Walk-forward.** Rows are ordered by time; each fold trains only on rows
 *    strictly before the fold and predicts it. No fold sees its own future.
 *  - **Purged folds.** A row's label spans `horizon` bars, so the rows
 *    immediately before a test fold are dropped — otherwise a training label
 *    overlaps the very period it is scored against.
 *  - **Basket P&L.** Positions sharing a timestamp are simultaneous, so the
 *    equity path advances once per bar on the equal-weight basket return (see
 *    `tradeStats`). Compounding them per row would apply the book's variance
 *    once per coin and report a flat strategy as a total loss.
 *  - **Realised P&L.** Every prediction above the confidence threshold is
 *    traded against the actual forward return, fees and slippage charged on
 *    both sides.
 *  - **Deflated Sharpe**, with a minimum-sample guard (see `significanceOf`).
 *
 * Read the significance block, not the headline. `perTrade` is expectancy on
 * the *filtered* dataset (rows whose forward move exceeds half the typical bar
 * move), and a threshold sweep reliably produces a configuration with a
 * spectacular expectancy on a handful of trades. The deflated Sharpe and
 * `insufficient_sample` flag exist to catch exactly that, and a config is not a
 * result until it clears both.
 */

import { buildUniverseDataset, classificationMetrics } from "./dataset.js";
import { fit, predictProbability } from "./logistic.js";
import { returnMoments, deflatedSharpeRatio, effectiveTrials } from "./stats.js";
import { combinatorialPurgedCV, makeEvent } from "./purged.js";

const DEFAULTS = {
  horizon: 3,
  feePct: 0.001,
  slippagePct: 0.0005,
  minConfidence: 0.2,
  folds: 4,
  epochs: 400,
};

/**
 * A significance verdict computed on fewer than this many trades is refused.
 *
 * This is not a formality. A confidence sweep on this project's own data gave
 * 8,004 trades at −0.36%/trade, 398 at +1.36%, and just 14 at +9.98% — with the
 * "significance" score *rising* as the sample shrank. That is the signature of
 * a small-sample artefact, and reporting the 14-trade result as performance
 * would be the most misleading thing this model could do.
 */
const MIN_TRADES = 200;

export function backtestUniverse(universe, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const { X, y, indices, meta } = buildUniverseDataset(universe, { horizon: cfg.horizon });
  if (X.length < 200) return { ok: false, reason: `only ${X.length} cross-sectional rows`, samples: X.length };

  const n = X.length;
  const foldSize = Math.floor(n / cfg.folds);
  const probs = new Array(n).fill(0.5);
  const folds = [];
  const trades = [];
  const foldReturns = [];

  for (let f = 0; f < cfg.folds; f++) {
    const testFrom = n - (cfg.folds - f) * foldSize;
    const testTo = Math.min(testFrom + foldSize - 1, n - 1);
    if (testFrom <= 0) continue;

    // Purge: drop training rows whose `horizon`-bar label reaches into the
    // test block, rather than merely being out of date.
    const trainIdx = [];
    for (let i = 0; i < testFrom - cfg.horizon; i++) trainIdx.push(i);
    if (trainIdx.length < 200) continue;

    const model = fit(trainIdx.map((i) => X[i]), trainIdx.map((i) => y[i]), { epochs: cfg.epochs });

    let foldCorrect = 0;
    const foldRets = [];
    for (let i = testFrom; i <= testTo; i++) {
      const p = predictProbability(model, X[i]);
      probs[i] = p;
      if ((p >= 0.5 ? 1 : 0) === y[i]) foldCorrect++;

      // Sit out marginal calls. Taking every prediction is not the same
      // strategy as taking the ones worth taking, and conflating the two
      // flatters the hit rate while destroying the P&L.
      if (Math.abs(p - 0.5) * 2 < cfg.minConfidence) continue;

      const dir = p >= 0.5 ? 1 : -1;
      const net = dir * indices[i].fwdRet - 2 * (cfg.feePct + cfg.slippagePct);
      trades.push({ net, symbol: indices[i].symbol, ts: indices[i].ts });
      foldRets.push(net);
    }
    if (foldRets.length >= 4) foldReturns.push(foldRets);
    folds.push({
      test_rows: testTo - testFrom + 1,
      train_rows: trainIdx.length,
      accuracy: foldCorrect / (testTo - testFrom + 1),
      trades: foldRets.length,
    });
  }

  const metrics = classificationMetrics(probs, y);
  return {
    ok: true,
    model: "logistic-xs",
    horizon: cfg.horizon,
    coins: meta.coins,
    samples: metrics.samples,
    accuracy: metrics.accuracy,
    precision: metrics.precision,
    recall: metrics.recall,
    brier: metrics.brier,
    base_rate: metrics.up_rate,
    trades: tradeStats(trades),
    folds,
    significance: significanceOf(foldReturns),
    cpcv: { splits: combinatorialPurgedCV(indices.map((_, i) => makeEvent(i, cfg.horizon)), 6, 2, cfg.horizon).length },
    config: cfg,
  };
}

/** Exported for tests: the aggregation rule above is a correctness property,
 * not an implementation detail, so it is pinned directly. */
export { tradeStats };

/** Trade-level P&L, in the same shape the per-coin backtest returns.
 *
 * `trades` arrive in dataset row order, which for a cross-sectional model means
 * *all* coins at timestamp 1, then all coins at timestamp 2, and so on. Those
 * positions are open simultaneously, not one after another. Compounding them in
 * row order treats one hour of a 20-coin book as 20 successive bets, which
 * applies the full variance of the book twenty times over: a genuinely flat
 * strategy reads as a catastrophic loss. That is not a rounding detail, it
 * invents a drawdown that never happened and hides a real one behind it.
 *
 * So the equity path advances once per timestamp, on the equal-weight basket
 * return for that bar. The path a real account experiences is the basket's, and
 * per-trade expectancy stays reported per trade.
 */
function tradeStats(trades) {
  if (!trades.length) {
    return { count: 0, wins: 0, winRate: 0, expectancy: 0, totalReturn: 0, maxDrawdown: 0, periods: 0 };
  }
  const rets = trades.map((t) => t.net);
  const wins = rets.filter((r) => r > 0).length;
  const expectancy = rets.reduce((s, r) => s + r, 0) / rets.length;

  // Equal-weight basket return per timestamp, in chronological order.
  const byTs = new Map();
  for (const t of trades) {
    if (!byTs.has(t.ts)) byTs.set(t.ts, []);
    byTs.get(t.ts).push(t.net);
  }
  const basket = [...byTs.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, ns]) => ns.reduce((s, r) => s + r, 0) / ns.length);

  let equity = 1;
  let peak = 1;
  let maxDd = 0;
  for (const r of basket) {
    equity *= 1 + r;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, 1 - equity / peak);
  }
  return {
    count: rets.length,
    wins,
    winRate: wins / rets.length,
    expectancy,
    totalReturn: equity - 1,
    maxDrawdown: maxDd,
    periods: basket.length,
  };
}

/** Deflated Sharpe over the folds, which are the trials. */
function significanceOf(foldReturns) {
  const moments = foldReturns.filter((r) => r.length >= 4).map((r) => returnMoments(r));
  const totalTrades = foldReturns.reduce((s, r) => s + r.length, 0);
  if (!moments.length || totalTrades < MIN_TRADES) {
    return {
      deflated_sharpe: 0,
      expected_max_sharpe: 0,
      effective_trials: foldReturns.length,
      sharpe: 0,
      observations: totalTrades,
      significant: false,
      // Explicit, so a zero here reads as "no evidence", not "not computed".
      insufficient_sample: totalTrades < MIN_TRADES,
      min_trades: MIN_TRADES,
    };
  }
  const sharpes = moments.map((m) => m.sharpe);
  const best = moments.reduce((a, m) => (m.sharpe > a.sharpe ? m : a));
  const dsr = deflatedSharpeRatio(best.sharpe, sharpes, best.T, best.skewness, best.kurtosis);
  return {
    deflated_sharpe: dsr.dsr,
    expected_max_sharpe: dsr.expectedMaxSR,
    effective_trials: effectiveTrials(foldReturns),
    sharpe: best.sharpe,
    observations: totalTrades,
    significant: dsr.dsr >= 0.95,
    insufficient_sample: false,
    min_trades: MIN_TRADES,
  };
}
