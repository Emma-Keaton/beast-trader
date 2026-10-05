/**
 * Model trainer CLI.
 *
 *   npm run train            # fetch history, backtest, train, save model
 *   npm run train -- --offline   # use only cached history (no network)
 *
 * Flow: fetch daily bars per coin -> backtest per coin (out-of-sample) ->
 * pool the honest out-of-sample rows -> fit the final model on all of it ->
 * write `backend/data/models/direction-v3.json` + a human-readable report.
 *
 * v3 is the DEX-aware layout: when `dex_snapshots` covers enough of the pooled
 * rows, `liquidity_trend` and `buy_sell_imbalance` are appended (20 features);
 * otherwise the coverage floor strips them and an 18-feature model is written,
 * identical in layout to v2. The walk-forward evaluation is always built from
 * the same inputs as the saved model, so the reported numbers describe the
 * artefact on disk either way.
 *
 * The model that ships is only ever trained on data the backtest never
 * touched at the point it predicted, so the reported metrics describe
 * out-of-sample behaviour rather than memorisation.
 */

import fs from "node:fs";
import path from "node:path";
import { config } from "../src/config.js";
import { fetchDailyBars, TRAINING_UNIVERSE } from "../src/ml/history.js";
import { backtest } from "../src/ml/backtest.js";
import { buildUniverseDataset } from "../src/ml/dataset.js";
import { evaluate } from "../src/ml/evaluate.js";
import { backtestUniverse } from "../src/ml/backtestXs.js";
import { fit, predictProbability } from "../src/ml/logistic.js";
import { FEATURE_NAMES } from "../src/ml/features.js";
import { XS_FEATURE_NAMES } from "../src/ml/xsfeatures.js";
import { DEX_FEATURE_NAMES, buildDexIndex } from "../src/ml/dexfeatures.js";
import { listAllRows } from "../src/store.js";

const OUT_DIR = path.join(config.dataDir, "models");
const OFFLINE = process.argv.includes("--offline");
const TRADE_THRESHOLD = 0.2;
const HORIZON = 3;

/**
 * Confidence a prediction must clear before it is traded.
 *
 * Fixed in advance rather than chosen by sweeping the test set. A sweep on this
 * data produced per-trade results of −0.18% (no threshold), +1.36% (0.2) and
 * +5.38% (0.3) — and the last of those is on 95 trades, i.e. noise. Picking the
 * best-looking threshold *after* seeing those numbers is itself a trial, and
 * the DSR does not know about it. 0.2 is therefore a decision made once, on the
 * reasoning that a third of predictions is a reasonable selectivity, not a
 * number harvested from the results.
 */

/**
 * Minimum fraction of pooled rows that must have an observed DEX state before
 * the DEX columns are kept.
 *
 * 0.25, not 0: below roughly a quarter the columns are mostly neutral padding,
 * and a scaler fitted to a 75%-constant column learns a mean and a std that
 * describe the padding rather than the market. The floor turns "we collected
 * three hours of snapshots" from a silent model-layout change into an explicit,
 * logged decision — and `buildUniverseDataset` strips the columns identically
 * for the training pool and the walk-forward evaluation, so the two can never
 * disagree about the width.
 */
const MIN_DEX_COVERAGE = 0.25;

/**
 * Load stored `dex_snapshots` and index them by symbol.
 *
 * Every failure mode — no database, no table, no rows yet — means the same
 * thing: train without DEX features. Collection is allowed to start *after*
 * the first training run, so an absent history must not fail the trainer; the
 * coverage floor and the log line make the resulting layout decision visible.
 */
async function loadDexIndex() {
  try {
    const rows = await listAllRows("dex_snapshots", "ts.asc", 20_000);
    if (!rows.length) return { index: null, count: 0 };
    return { index: buildDexIndex(rows), count: rows.length };
  } catch (e) {
    console.warn(`[train] dex_snapshots unavailable (${e.message}) - DEX features will be neutral/absent`);
    return { index: null, count: 0 };
  }
}

async function main() {
  console.log(`[train] mode=${OFFLINE ? "offline" : "online"} horizon=${HORIZON}d`);

  const perCoin = [];
  /** Every coin's bars, keyed by symbol, for the cross-sectional build. */
  const bySymbol = new Map();

  for (const coin of TRAINING_UNIVERSE) {
    let data;
    try {
      data = await fetchDailyBars(coin.id, coin.symbol, 5000, { offline: OFFLINE });
    } catch (e) {
      console.warn(`[train] ${coin.symbol}: skipped (${e.message})`);
      continue;
    }
    const report = backtest(data.bars, { horizon: HORIZON });
    if (!report.ok) {
      console.warn(`[train] ${coin.symbol}: ${report.reason}`);
      continue;
    }

    // Keep the longest series per symbol. The cache can hold duplicate
    // entries for the same coin from different fetch runs, and two copies of
    // the same coin would double its weight in the cross-section.
    const held = bySymbol.get(coin.symbol);
    if (!held || data.bars.length > held.bars.length) {
      bySymbol.set(coin.symbol, { symbol: coin.symbol, bars: data.bars });
    }

    perCoin.push({
      symbol: coin.symbol,
      bars: data.bars.length,
      samples: report.samples,
      accuracy: report.accuracy,
      brier: report.brier,
      trades: report.trades.count,
      winRate: report.trades.winRate,
      expectancy: report.trades.expectancy,
      totalReturn: report.trades.totalReturn,
      maxDrawdown: report.trades.maxDrawdown,
      deflated_sharpe: report.significance?.deflated_sharpe ?? 0,
    });
    console.log(
      `[train] ${coin.symbol.padEnd(5)} bars=${String(data.bars.length).padStart(4)} ` +
        `acc=${(report.accuracy * 100).toFixed(1)}% trades=${String(report.trades.count).padStart(3)} ` +
        `win=${(report.trades.winRate * 100).toFixed(0)}% perTrade=${(report.trades.expectancy * 100).toFixed(3)}%`,
    );
    // Pace requests to stay inside the free-tier rate limit.
    await new Promise((r) => setTimeout(r, 1200));
  }

  if (!perCoin.length) {
    console.error("[train] no coin produced a usable backtest — nothing saved");
    process.exitCode = 1;
    return;
  }

  // Fit on the cross-sectional set: every coin's features, expressed relative
  // to the market at the same instant, labelled on volatility-scaled forward
  // returns. This is the change that makes the model learn *relative* strength
  // rather than the market's own direction - see the note in `xsfeatures.js`
  // for the Liu/Tsyvinski/Wu result behind it.
  const universe = [...bySymbol.values()];
  const dex = await loadDexIndex();
  const pool = buildUniverseDataset(universe, {
    horizon: HORIZON,
    dexIndex: dex.index,
    minDexCoverage: MIN_DEX_COVERAGE,
  });
  if (!pool.X.length) {
    console.error("[train] cross-sectional dataset is empty - nothing saved");
    process.exitCode = 1;
    return;
  }
  const featureNames = [...FEATURE_NAMES, ...XS_FEATURE_NAMES, ...(pool.meta.dexIncluded ? DEX_FEATURE_NAMES : [])];
  console.log(
    `\n[train] cross-sectional set: ${pool.X.length} rows x ${featureNames.length} features ` +
      `from ${universe.length} coins (${pool.meta.skippedUndecidable} undecidable rows dropped)`,
  );
  // The layout decision, stated where a human reading the training log cannot
  // miss it: 20 features means the model can see DEX state; 18 means it cannot.
  if (pool.meta.dexIncluded) {
    console.log(
      `[train] DEX features ON: ${dex.count} snapshots cover ${(pool.meta.dexCoverage * 100).toFixed(1)}% of rows`,
    );
  } else if (dex.index) {
    console.warn(
      `[train] DEX features OFF: only ${(pool.meta.dexCoverage * 100).toFixed(1)}% coverage ` +
        `(< ${MIN_DEX_COVERAGE * 100}% floor) - training the 18-feature layout`,
    );
  } else {
    console.log("[train] DEX features OFF: no dex_snapshots collected yet - 18-feature layout");
  }

  // Honest out-of-sample evaluation of the model that will actually ship. The
  // per-coin backtest is built from different features and labels, so quoting
  // it here would describe a system that is not the one running in production.
  const xs = backtestUniverse(universe, {
    horizon: HORIZON,
    minConfidence: TRADE_THRESHOLD,
    dexIndex: dex.index,
    minDexCoverage: MIN_DEX_COVERAGE,
  });
  if (!xs.ok) {
    console.error(`[train] cross-sectional evaluation failed: ${xs.reason} - nothing saved`);
    process.exitCode = 1;
    return;
  }

  const model = fit(pool.X, pool.y, { epochs: 300, featureNames });
  const stats = aggregate(perCoin, xs);

  // The promotion gate decides whether this model is allowed to trade. It is
  // evaluated on out-of-sample numbers only, and the verdict is saved with
  // the model so the app can explain itself honestly.
  const verdict = evaluate(stats);

  const trained = {
    ...model,
    // Feature names are recorded so a model trained with the old 12-feature
    // layout can never be loaded as if it were the new 18-feature one.
    features: featureNames,
    trainedAt: new Date().toISOString(),
    horizon: HORIZON,
    universe: universe.map((u) => u.symbol),
    samples: pool.X.length,
    crossSectional: true,
    aggregate: stats,
    promoted: verdict.promoted,
    verdict,
  };

  // Verify the fresh model scores cleanly before committing it to disk, so a
  // bad artefact fails here rather than silently in the polling loop.
  const probe = new Array(model.features.length).fill(0);
  if (!Number.isFinite(predictProbability(model, probe))) {
    throw new Error("model produced a non-finite probability — refusing to save");
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, "direction-v3.json");
  fs.writeFileSync(file, JSON.stringify(trained, null, 2));

  console.log("\n[train] -- out-of-sample results ----------------------------");
  console.log(`  accuracy      ${(stats.accuracy * 100).toFixed(1)}%  (a guess is 50%)`);
  console.log(`  brier score   ${stats.brier.toFixed(4)}  (a guess is 0.25, lower is better)`);
  console.log(`  trades        ${stats.trades}`);
  console.log(`  win rate      ${(stats.winRate * 100).toFixed(1)}%`);
  console.log(`  per trade     ${(stats.expectancy * 100).toFixed(3)}%  (after fees + slippage)`);
  console.log(`  biggest fall  ${(stats.maxDrawdown * 100).toFixed(1)}%`);
  console.log(`  chance it is real  ${(stats.deflated_sharpe * 100).toFixed(1)}%  (after accounting for everything we tried)`);
  // The P&L lines above are expectancy on the rows this model was *fitted* to.
  // A confidence-threshold sweep reliably turns up a config with a spectacular
  // per-trade number on a dozen trades, so the sample size and the deflated
  // figure are the two numbers that decide whether any of this is real.
  if (xs.significance?.insufficient_sample) {
    console.log(
      `\n  WARNING: only ${xs.significance.observations} trades in this evaluation —` +
        ` below the ${xs.significance.min_trades} needed to judge it.`,
    );
    console.log("  The per-trade and win-rate figures above are not trustworthy yet.");
  }

  console.log(`\n[train] -- verdict -------------------------------------------`);
  if (verdict.promoted) {
    console.log(`  PROMOTED: ${verdict.headline}`);
  } else {
    console.log("  NOT PROMOTED - it will give ideas but will not trade on its own:");
    for (const r of verdict.reasons) console.log(`    - ${r}`);
  }
  console.log(`\n[train] saved ${file}`);
  console.log("[train] strongest signals:");
  model.features
    .map((name, j) => ({ name, w: model.weights[j] }))
    .sort((a, b) => Math.abs(b.w) - Math.abs(a.w))
    .slice(0, 5)
    .forEach(({ name, w }) => console.log(`   ${name.padEnd(12)} ${w >= 0 ? "+" : ""}${w.toFixed(3)}`));
}

/**
 * The numbers the promotion gate sees.
 *
 * These come from the cross-sectional walk-forward evaluation, because that is
 * the model being shipped. The per-coin backtests are kept alongside as a
 * per-asset view, never as the headline — they use different features and
 * absolute labels, and averaging them into the verdict would describe a model
 * that is not the one running.
 */
function aggregate(rows, xs) {
  const avg = (k) => rows.reduce((s, r) => s + r[k], 0) / rows.length;
  // `xs` is the cross-sectional walk-forward result: its P&L lives under
  // `trades` and its significance under `significance`. Flattening it here
  // means the promotion gate below always reads numbers produced by the model
  // that actually ships, never the per-coin averages.
  return {
    coins: rows.length,
    accuracy: xs.accuracy,
    precision: xs.precision,
    brier: xs.brier,
    winRate: xs.trades.winRate,
    expectancy: xs.trades.expectancy,
    totalReturn: xs.trades.totalReturn,
    maxDrawdown: xs.trades.maxDrawdown,
    deflated_sharpe: xs.significance.deflated_sharpe,
    trades: xs.trades.count,
    // The per-asset view, kept for the report but never used for the verdict.
    perCoinAccuracy: avg("accuracy"),
    perCoinBrier: avg("brier"),
    perCoin: rows,
    crossSectional: xs,
  };
}

main().catch((e) => {
  console.error("[train] failed:", e);
  process.exitCode = 1;
});
