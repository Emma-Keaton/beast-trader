/**
 * Model registry — loads the trained direction model once and exposes it to
 * the live prediction path.
 *
 * The server must never hard-fail because a model file is missing or
 * corrupted: `getModel()` returns null in that case and `predict()` quietly
 * falls back to the deterministic heuristic. Trading stops being a
 * hard dependency on a training run having happened.
 */

import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

const MODEL_FILE = path.join(config.dataDir, "models", "direction-v2.json");
const RELOAD_MS = 5 * 60_000; // pick up a fresh training run without a restart

let cache = null;
let loadedAt = 0;

export function getModel() {
  const fresh = Date.now() - loadedAt < RELOAD_MS;
  if (cache && fresh) return cache;
  try {
    const stat = fs.statSync(MODEL_FILE);
    if (cache && cache.__mtime === stat.mtimeMs) {
      loadedAt = Date.now();
      return cache;
    }
    const parsed = JSON.parse(fs.readFileSync(MODEL_FILE, "utf8"));
    if (!parsed?.scaler || !Array.isArray(parsed.weights)) throw new Error("malformed model file");
    cache = { ...parsed, __mtime: stat.mtimeMs };
    loadedAt = Date.now();
    return cache;
  } catch {
    cache = null;
    loadedAt = Date.now();
    return null;
  }
}

export function modelInfo() {
  const m = getModel();
  if (!m) return { trained: false, name: "simple-rules" };
  return {
    trained: true,
    promoted: Boolean(m.promoted),
    name: m.kind || "logistic",
    version: m.version,
    trainedAt: m.trainedAt ?? null,
    horizon: m.horizon ?? null,
    samples: m.samples ?? null,
    coins: m.universe?.length ?? null,
    verdict: m.verdict ?? null,
    metrics: m.aggregate
      ? {
          accuracy: m.aggregate.accuracy,
          brier: m.aggregate.brier,
          winRate: m.aggregate.winRate,
          expectancy: m.aggregate.expectancy,
          trades: m.aggregate.trades,
          maxDrawdown: m.aggregate.maxDrawdown,
        }
      : null,
  };
}

/**
 * True only when a model exists AND passed the promotion gate. Autopilot
 * checks this, so an unproven model can suggest trades but never place one.
 */
export function canAutoTrade() {
  return Boolean(getModel()?.promoted);
}

export { MODEL_FILE };
