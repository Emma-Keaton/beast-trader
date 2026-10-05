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

/**
 * Every model file this deployment will load, newest layout first.
 *
 * `direction-v3.json` carries the DEX columns (20 features) and
 * `direction-v2.json` is the original cross-sectional model (18). The loader
 * takes the first file that exists, so an environment that has only ever
 * trained v2 keeps working, and a fresh `npm run train` promotes itself to v3
 * on the next reload without a restart.
 */
const MODEL_FILES = ["direction-v3.json", "direction-v2.json"].map((f) => path.join(config.dataDir, "models", f));

/**
 * The file tests exist-check against: whichever trained model this data root
 * actually has, preferring v3. Falls back to the v2 path when neither exists
 * (so the name is still meaningful in messages).
 */
const MODEL_FILE = MODEL_FILES.find((f) => fs.existsSync(f)) ?? MODEL_FILES[MODEL_FILES.length - 1];
const RELOAD_MS = 5 * 60_000; // pick up a fresh training run without a restart

let cache = null;
let loadedAt = 0;

/** Newest existing model file, re-resolved on every reload so a v3 written
 * while the server is running is picked up without a restart. */
function locateModel() {
  for (const f of MODEL_FILES) {
    try {
      return { file: f, stat: fs.statSync(f) };
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

export function getModel() {
  const fresh = Date.now() - loadedAt < RELOAD_MS;
  if (cache && fresh) return cache;
  try {
    const found = locateModel();
    if (!found) throw new Error("no model file");
    if (cache && cache.__file === found.file && cache.__mtime === found.stat.mtimeMs) {
      loadedAt = Date.now();
      return cache;
    }
    const parsed = JSON.parse(fs.readFileSync(found.file, "utf8"));
    if (!parsed?.scaler || !Array.isArray(parsed.weights)) throw new Error("malformed model file");
    cache = { ...parsed, __file: found.file, __mtime: found.stat.mtimeMs };
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
