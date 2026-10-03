/**
 * The app's self-improvement service.
 *
 * This is the single place the improvement loop is driven from, so the poller,
 * the API, and the tests all exercise exactly the same code path.
 *
 * Everything it does is deliberately invisible to a user's decisions: it reads
 * settled paper calls, scores candidate models against them, and occasionally
 * proposes a better one. It never places a trade, never touches a user's
 * settings, and never changes the champion without clearing the promotion gate.
 *
 * Models are shared across the whole app rather than per user, so one user's
 * settled calls genuinely improve the model everybody trades on. That is only
 * sound because those calls are real forward returns captured with their
 * features — see `retrain.js`.
 */

import { listAllRows } from "../store.js";
import { config } from "../config.js";
import { improvementCycle, normaliseOrders } from "../ml/retrain.js";
import { improvementState, getChampion, promoteChallenger } from "../ml/strategies.js";
import { board, settleCalls } from "../ml/scoreboard.js";

/** Only settled calls with a captured feature vector are useful for training. */
const MIN_ROWS = 40;

let lastReport = null;

/**
 * One cycle of "improve myself", using settled calls from every device.
 *
 * @returns `{ ran, reason, promotion, trained }`
 */
export async function runImprovementCycle(opts = {}) {
  let calls = [];
  let orders = [];
  try {
    calls = await listAllRows("paper_calls", "settled_at.desc", 5000);
  } catch (err) {
    // A store failure must never take down a polling tick.
    return { ran: false, reason: `could not read settled calls: ${err.message}` };
  }
  // Orders are a second, independent training source: real fills rather than
  // rehearsals. A failure to read them degrades the cycle rather than ending
  // it, since the paper ledger alone is still a valid training set.
  try {
    orders = await listAllRows("orders", "settled_at.desc", 5000);
  } catch (err) {
    console.warn("[improve] settled orders unavailable:", err.message);
  }

  calls = [
    ...(calls ?? []).filter((c) => c.status === "settled"),
    ...normaliseOrders((orders ?? []).filter((o) => o.status === "settled" && o.settled_at)),
  ];
  // The settled paper ledger is also what closes out the scoreboard: every
  // model's prediction is attached to one of these calls, so settling them here
  // is what lets the board rank models against identical realised prices.
  await settleScoreboard().catch(() => {});

  if (calls.length < MIN_ROWS) {
    return { ran: false, reason: `only ${calls.length} settled calls so far, need ${MIN_ROWS}`, calls: calls.length };
  }

  const championStats = championTrackRecord(calls);
  const report = await improvementCycle(calls, championStats, opts);

  // Promotion is applied only after `evaluatePromotion` cleared the gate.
  if (report.promotion?.promote && report.promotion.winner) {
    await promoteChallenger(report.promotion.winner.id);
    report.promoted = report.promotion.winner.id;
  }

  lastReport = report;
  return report;
}

/**
 * The champion's own live track record, measured on the same settled calls the
 * challengers are scored against — so "better" means better, not merely
 * different.
 */
function championTrackRecord(calls) {
  const champion = getChampion();
  if (!champion?.weights || !Array.isArray(champion.weights)) return null;

  const rets = [];
  for (const c of calls) {
    if (!Array.isArray(c.features) || c.features.length !== champion.weights.length) continue;
    if (!Number.isFinite(c.entry_price) || !Number.isFinite(c.exit_price) || c.entry_price <= 0) continue;
    const moved = Math.log(c.exit_price / c.entry_price);
    // Compare against the direction the champion actually recommended.
    const dir = c.side === "LONG" ? 1 : -1;
    rets.push(dir * moved - 0.0015);
  }
  if (!rets.length) return null;
  return {
    settled: rets.length,
    expectancy: rets.reduce((s, x) => s + x, 0) / rets.length,
    winRate: rets.filter((r) => r > 0).length / rets.length,
  };
}

/** Everything the UI needs to show how the models are progressing. */
export async function improvementReport() {
  return {
    ...improvementState(),
    lastCycle: lastReport
      ? {
          at: lastReport.at,
          trained: lastReport.trained,
          promoted: lastReport.promoted ?? null,
          promotionReason: lastReport.promotion?.reason ?? null,
        }
      : null,
  };
}

export { MIN_ROWS };

/**
 * Settle every model's pending predictions against the paper ledger.
 *
 * Each model's prediction is keyed to a `paper_calls` id, so the outcome is the
 * one the app actually recorded — entry price, exit price, and the direction the
 * primary model took. Every model is then scored against that same outcome,
 * which is the only way a ranking between them means anything.
 *
 * Models are settled independently so one with no history cannot block another.
 */
async function settleScoreboard() {
  const settled = await listAllRows("paper_calls", "settled_at.desc", 2000);
  const byId = new Map();
  for (const c of settled ?? []) {
    if (c?.status !== "settled" || !c.id) continue;
    const entry = Number(c.entry_price);
    const exit = Number(c.exit_price);
    if (!Number.isFinite(entry) || !Number.isFinite(exit) || entry <= 0) continue;
    byId.set(String(c.id), {
      up: exit > entry ? 1 : 0,
      // Net return the app recorded, so a model is scored on what it would
      // actually have earned rather than on a frictionless price move.
      returnPct: Number.isFinite(c.return_pct) ? c.return_pct : 0,
    });
  }
  if (!byId.size) return 0;

  let total = 0;
  for (const model of board().models) {
    total += await settleCalls(model.model, Object.fromEntries(byId)).catch(() => 0);
  }
  return total;
}

/** Days a deployment must accumulate before we call the loop "on track". */
const TARGET_DAYS = 7;

/**
 * A snapshot of whether the self-improvement loop is genuinely running.
 *
 * Designed for the week-long unattended paper-trading phase. Every field is
 * something an operator can act on: if `settledCalls` is flat while `daysObserved`
 * climbs, the poller has stopped and nothing is being learned, however healthy
 * the rest of the app looks.
 */
export async function learningProgress() {
  let calls = [];
  let orders = [];
  try {
    calls = await listAllRows("paper_calls", "created_at.desc", 5000);
  } catch (err) {
    return {
      ok: false,
      reason: `could not read paper calls: ${err.message}`,
      onTrack: false,
    };
  }
  // Orders count toward training too, so an operator watching only settledCalls
  // would under-read real progress as soon as the autopilot starts trading.
  try {
    orders = await listAllRows("orders", "created_at.desc", 5000);
  } catch (err) {
    console.warn("[improve] orders unavailable for progress:", err.message);
  }

  const settledOrders = orders.filter((o) => o.status === "settled" && o.settled_at);
  const settled = [...calls.filter((c) => c.status === "settled"), ...normaliseOrders(settledOrders)];
  const open = calls.filter((c) => c.status !== "settled");
  // Only rows with a captured feature vector can train a model, so this — not
  // the raw settled count — is the number that determines real progress.
  const trainable = settled.filter((c) => Array.isArray(c.features) && c.features.length);

  const stamps = [
    ...calls.map((c) => Date.parse(c.created_at ?? c.createdAt ?? "")),
    ...orders.map((o) => Date.parse(o.created_at ?? "")),
  ].filter(Number.isFinite);
  const daysObserved = stamps.length ? (Date.now() - Math.min(...stamps)) / 86_400_000 : 0;

  const state = improvementState();
  const bestChallenger = state.challengers?.[0];

  return {
    ok: true,
    mode: config.tradingMode,
    daysObserved: Number(daysObserved.toFixed(2)),
    targetDays: TARGET_DAYS,
    totalCalls: calls.length,
    settledCalls: settled.length,
    openCalls: open.length,
    trainableCalls: trainable.length,
    // Provenance matters once orders contribute: a training set split between
    // rehearsals and real fills is not the same evidence as either alone.
    fromOrders: settledOrders.length,
    // The gap to the next retrain, so the UI can show progress toward it
    // instead of a bare "not enough data".
    callsUntilRetrain: Math.max(0, MIN_ROWS - trainable.length),
    firstCallAt: stamps.length ? new Date(Math.min(...stamps)).toISOString() : null,
    lastCycleAt: lastReport?.at ?? null,
    lastCycleDidWork: lastReport ? Boolean(lastReport.trained?.ran || lastReport.promoted) : false,
    champion: state.champion,
    bestChallenger: bestChallenger
      ? {
          label: bestChallenger.label,
          settled: bestChallenger.settled,
          expectancy: bestChallenger.expectancy,
          ageDays: bestChallenger.ageDays ?? null,
          eligible: bestChallenger.eligible,
          // The loss profile, so a model held back for an 86% drawdown says so
          // rather than showing an unexplained "not eligible". Expectancy alone
          // looks fine on exactly the models this gate exists to stop.
          maxDrawdown: bestChallenger.risk?.stats?.maxDrawdown ?? null,
          profitFactor: bestChallenger.risk?.stats?.profitFactor ?? null,
          riskOk: bestChallenger.risk?.ok ?? null,
          riskWhy: bestChallenger.risk?.why ?? null,
        }
      : null,
    // Conservative on purpose: elapsed time alone is not progress, and a burst
    // of correlated calls is not evidence either. Both must hold.
    onTrack: daysObserved >= TARGET_DAYS && trainable.length >= MIN_ROWS,
  };
}