import { config } from "../config.js";
import { devicesWithWatchlist, getSettings, insertRow, listCollection } from "../store.js";
import { research } from "./research.js";
import { maybeAutoTrade, settleOrders } from "./executor.js";
import { livePrice, marketSnapshot } from "./snapshot.js";
import { openCall, settleMatured } from "../ml/paper.js";
import { recordSignal } from "../ml/scoreboard.js";
import { forecastEnsemble } from "./predict.js";
import { runAutoExecutor } from "./autoexec.js";
import { runImprovementCycle } from "./improve.js";
import { tick as dexTick } from "./dexwatch.js";

/**
 * Watchlist auto-poller.
 * - Runs every config.pollIntervalMs (default 30s — comfortably inside
 *   CoinGecko free (~30 req/min, batched) and DexScreener limits).
 * - Manual refresh endpoint reuses runOnce() but is throttled to
 *   config.refreshThrottleMs (default 15s) per device.
 * - Each tick per watchlist item: snapshot -> research note -> prediction ->
 *   store research_logs -> paper record -> autopilot gate -> paper order.
 */

const lastManual = new Map(); // deviceId -> ts
const latest = new Map(); // `${deviceId}:${symbol}` -> { snapshot, note, at }

export function isSnappy(symbol, deviceId) {
  return latest.get(`${deviceId}:${symbol}`) || null;
}

export async function runOnce(deviceId) {
  const watchlist = await listCollection("watchlist", deviceId, "created_at.asc");
  const settings = await getSettings(deviceId);
  const results = [];
  for (const item of watchlist) {
    try {
      const snapshot = await marketSnapshot(item);
      if (!snapshot || snapshot.price_usd == null) continue;
      const note = await research(snapshot);
      await insertRow("research_logs", {
        device_id: deviceId,
        token: snapshot.symbol,
        data_json: note,
        signal: note.prediction.signal,
        confidence: note.prediction.confidence,
      });
      latest.set(`${deviceId}:${snapshot.symbol}`, { snapshot, note, at: Date.now() });
      // Rehearsal: record the call now, settle it later against real prices.
      const call = await openCall(deviceId, snapshot, note.prediction).catch(() => {});
      await settleMatured(deviceId, livePrice).catch(() => {});
      // Settle real paper fills too. Without this, executed orders stay display
      // rows forever and never contribute a labelled example to training.
      await settleOrders(deviceId, livePrice).catch(() => {});
      // Every model's opinion is recorded against the same call, so the board
      // ranks them on identical outcomes rather than on separate backtests.
      await recordEveryModel(deviceId, snapshot, note.prediction, call).catch(() => {});
      await maybeAutoTrade(deviceId, snapshot, note.prediction, settings || {});
      results.push({ symbol: snapshot.symbol, note });
    } catch (err) {
      console.warn(`[poller] ${deviceId}/${item.symbol}:`, err.message);
    }
    await new Promise((r) => setTimeout(r, 250)); // gentle pacing between items
  }
  return results;
}

/**
 * Record every model's opinion on this snapshot against one shared call.
 *
 * The point of a scoreboard is that models are compared on *identical* outcomes.
 * So all of them are attached to the same `callId`, and when that call settles,
 * each is scored against the same realised price. Comparing models on separate
 * backtests would be comparing them on different data, which proves nothing.
 */
async function recordEveryModel(deviceId, snapshot, prediction, call) {
  const callId = call?.id ?? null;
  const symbol = snapshot.symbol;

  if (prediction && Number.isFinite(prediction.probability)) {
    await recordSignal(prediction.model ?? "primary", {
      callId,
      symbol,
      probUp: prediction.probability,
    });
  }

  const f = forecastEnsemble(snapshot);
  if (f?.ok) {
    await recordSignal("ensemble", { callId, symbol, probUp: f.probUp });
  }
}

export function manualRefresh(deviceId) {
  const now = Date.now();
  const prev = lastManual.get(deviceId) || 0;
  if (now - prev < config.refreshThrottleMs) {
    return { throttled: true, retry_in_ms: config.refreshThrottleMs - (now - prev) };
  }
  lastManual.set(deviceId, now);
  return { throttled: false, promise: runOnce(deviceId) };
}

/**
 * The self-improvement loop.
 *
 * Runs on its own slow timer rather than inside the polling tick: the models
 * are shared across all users, so the work is global, and training is far too
 * expensive to attempt on every 30-second tick.
 *
 * Every failure here is swallowed on purpose. A training problem must never
 * stop the app from pricing markets and serving predictions.
 */
function startImprovementLoop() {
  const timer = setInterval(async () => {
    try {
      const report = await runImprovementCycle();
      if (report.promoted) console.log(`[improve] promoted ${report.promoted}`);
      if (report.trained?.ran) console.log(`[improve] proposed ${report.trained.challenger} from ${report.trained.trained_on} calls`);
    } catch (err) {
      console.warn("[improve] cycle failed:", err.message);
    }
  }, config.improveIntervalMs);
  timer.unref?.();
  return timer;
}

/**
 * The auto-executor loop.
 *
 * Deliberately on its own slow timer, not the 30-second market poller. A sweep
 * across eight chains costs real API quota, and a candidate that is a good buy
 * this minute may be a poor one in fifteen — re-scanning the same top performers
 * every 30 seconds would burn the rate limit and produce duplicate decisions
 * about the same tokens.
 *
 * Every failure is swallowed. The executor must never be able to stop the app
 * from pricing markets and serving predictions.
 */
function startAutoExecLoop() {
  const timer = setInterval(
    async () => {
      try {
        const devices = await devicesWithWatchlist();
        for (const d of devices) {
          const r = await runAutoExecutor(d);
          if (r?.traded) console.log(`[autoexec] ${d}: ${r.traded} order(s) placed`);
        }
      } catch (err) {
        console.warn("[autoexec] sweep failed:", err.message);
      }
    },
    config.autoExecIntervalMs,
  );
  timer.unref?.();
  return timer;
}

/**
 * The DEX observation loop.
 *
 * On its own timer, separate from the 30-second market poller, because this is
 * not a per-user task: the snapshots are facts about pools, shared by everyone,
 * and the cost is metered. It collects Solana only for now — see dexwatch.tick.
 *
 * Runs once immediately as well as on the interval, because a collector that
 * waits a full period before its first observation means the first `liquidity_trend`
 * window does not exist for that long. On a Render spin-down the process is
 * usually short-lived, so an immediate first tick is often the ONLY tick.
 */
function startDexWatchLoop() {
  const run = async () => {
    try {
      await dexTick();
    } catch (err) {
      // Swallowed for the same reason every other loop here swallows: a
      // data-collection failure must never stop pricing and predictions.
      console.warn("[dexwatch] tick failed:", err.message);
    }
  };

  const timer = setInterval(run, config.dexWatchIntervalMs);
  timer.unref?.();
  run(); // immediate first observation
  return timer;
}

export function startPoller() {
  const timer = setInterval(async () => {
    try {
      const devices = await devicesWithWatchlist();
      for (const d of devices) await runOnce(d);
    } catch (err) {
      console.warn("[poller] tick failed:", err.message);
    }
  }, config.pollIntervalMs);
  timer.unref?.();
  startImprovementLoop();
  startAutoExecLoop();
  startDexWatchLoop();
  return timer;
}
