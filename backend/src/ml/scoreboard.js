/**
 * Model scoreboard.
 *
 * The app runs several models at once and must be able to say which is actually
 * any good. That requires something the champion/challenger registry does not
 * provide: those models all share one feature space, so they can be scored on
 * the same calls. These do not — the ensemble forecasts price paths and emits
 * no feature vector — so they can only be compared on *outcomes*.
 *
 * So every model that makes a call is recorded here, and every settled call is
 * scored against every one of them. The board answers one question: which model
 * would have been right most often, and by how much over a coin flip?
 *
 * Why this matters. Running a bad model alongside a good one is not free — if
 * the bad one wins a threshold sweep it becomes the champion and the app starts
 * trading a coin flip. Recording every model's opinion up front and scoring them
 * all against the same realised prices makes that visible before it costs money.
 *
 * The ranking is advisory. It promotes nothing on its own; promotion still runs
 * through the registry's gates in `strategies.js`.
 */

import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

const FILE = path.join(config.dataDir, "scoreboard.json");
const MAX_PER_MODEL = 500;

/** In-memory mirror so the hot path (prediction) never blocks on I/O. */
let cache = null;
let loadedAt = 0;
const TTL_MS = 5_000;

function read() {
  if (cache && Date.now() - loadedAt < TTL_MS) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    cache = { models: {}, updatedAt: null };
  }
  for (const k of Object.keys(cache.models ?? {})) cache.models[k].outcomes ??= [];
  loadedAt = Date.now();
  return cache;
}

function write() {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(cache, null, 2));
  } catch (err) {
    console.warn("[scoreboard] write failed:", err.message);
  }
}

/**
 * Record that a model made a call, and what it predicted.
 *
 * `callId` ties this to the paper ledger so the outcome can be attached later.
 * Re-recording the same (model, call) pair is a no-op: the poller runs every
 * 30 seconds and would otherwise turn one prediction into dozens.
 */
export async function recordSignal(model, { callId, symbol, probUp, at = Date.now() }) {
  if (!model || !Number.isFinite(probUp)) return;
  const db = read();
  const entry = (db.models[model] ??= { model, pending: [], outcomes: [] });
  if (callId && entry.pending.some((p) => p.callId === callId)) return;
  entry.pending.push({ callId: callId ?? null, symbol: symbol ?? null, probUp, at });
  // Bound the pending list so an unsettleable call cannot grow it forever.
  if (entry.pending.length > MAX_PER_MODEL) entry.pending = entry.pending.slice(-MAX_PER_MODEL);
  db.updatedAt = new Date().toISOString();
  write();
}

/**
 * Settle every pending call for a model against a realised outcome.
 *
 * @param outcomes `{ [callId]: { up: 0|1, returnPct: number } }`
 * @returns the number of calls settled
 */
export async function settleCalls(model, outcomes) {
  if (!model || !outcomes || !Object.keys(outcomes).length) return 0;
  const db = read();
  const entry = db.models[model];
  if (!entry) return 0;

  const still = [];
  let settled = 0;
  for (const p of entry.pending) {
    const o = p.callId ? outcomes[p.callId] : null;
    if (!o) {
      still.push(p);
      continue;
    }
    entry.outcomes.push({ probUp: p.probUp, up: o.up, returnPct: o.returnPct, at: p.at, symbol: p.symbol });
    settled++;
  }
  entry.pending = still;
  if (entry.outcomes.length > MAX_PER_MODEL) entry.outcomes = entry.outcomes.slice(-MAX_PER_MODEL);
  db.updatedAt = new Date().toISOString();
  write();
  return settled;
}

/**
 * Score one model's settled record.
 *
 * Brier is the primary number because it scores the *probability*, not just the
 * direction: a model right 55% of the time while claiming 90% confidence is
 * worse than useless, and only Brier catches that. Hit rate alone would reward
 * it.
 */
export function scoreModel(entry) {
  const o = entry?.outcomes ?? [];
  const n = o.length;
  if (!n) {
    return {
      model: entry?.model ?? "unknown",
      settled: 0,
      hitRate: null,
      brier: null,
      edge: null,
      meanReturn: null,
      rank: null,
      pending: (entry?.pending ?? []).length,
    };
  }
  let brier = 0;
  let hits = 0;
  let sumRet = 0;
  for (const r of o) {
    brier += (r.probUp - r.up) ** 2;
    if ((r.probUp >= 0.5 ? 1 : 0) === r.up) hits++;
    sumRet += Number(r.returnPct ?? 0);
  }
  brier /= n;
  return {
    model: entry.model,
    settled: n,
    hitRate: Number((hits / n).toFixed(4)),
    brier: Number(brier.toFixed(4)),
    // What the trades this model would have taken actually returned. This is
    // the number that decides whether it is worth trading, as opposed to
    // whether it is directionally right.
    meanReturn: Number((sumRet / n).toFixed(6)),
    // Brier below 0.25 beats a coin flip. Signed, so "worse than random" is
    // visible rather than implied by a number that merely looks fine.
    edge: Number((0.25 - brier).toFixed(4)),
    pending: (entry.pending ?? []).length,
    rank: null,
  };
}

/** The full board, best first, ranked by Brier then hit rate. */
export function board() {
  const db = read();
  const all = Object.values(db.models).map(scoreModel);
  const ranked = all
    .filter((s) => s.settled > 0)
    .sort((a, b) => a.brier - b.brier || b.hitRate - a.hitRate)
    .map((s, i) => ({ ...s, rank: i + 1 }));
  const unranked = all.filter((s) => s.settled === 0).map((s) => ({ ...s, rank: null }));
  return { models: [...ranked, ...unranked], updatedAt: db.updatedAt };
}

/** Remove a model's record. Used by tests and by an explicit reset. */
export async function resetBoard(model) {
  const db = read();
  if (model) delete db.models[model];
  else db.models = {};
  write();
}

/**
 * Test seam: force the next read to hit disk.
 *
 * The TTL cache means a test that writes the file directly would otherwise be
 * ignored for up to five seconds.
 */
export function invalidate() {
  cache = null;
  loadedAt = 0;
}