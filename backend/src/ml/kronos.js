/**
 * Kronos predictor tier (Modal sidecar).
 *
 * Calls the deployed modal-kronos service with the recent close series and
 * maps its distribution output onto the shared prediction contract so the
 * executor, routes and UI treat it like any other tier:
 *
 *   { signal, probability, confidence, target_price, stop_price,
 *     horizon, reason, model, basis }
 *
 * Always returns null (never throws) so a missing/unreachable sidecar falls
 * back to the trained-model tier without breaking trading. Enabled only when
 * KRONOS_SERVICE_URL is set.
 */

const KRONOS_SERVICE_URL = (process.env.KRONOS_SERVICE_URL || "").replace(/\/+$/, "");
const KRONOS_API_KEY = process.env.KRONOS_API_KEY || "";
const MIN_CLOSES = 60;

import { insertRow } from "../store.js";
import { usingSupabase } from "../config.js";

let logFailed = false;
async function logCall(row) {
  if (!usingSupabase) return;
  try {
    await insertRow("kronos_calls", row);
    logFailed = false;
  } catch (err) {
    // Warn once per outage, not per call, so a missing table does not spam.
    if (!logFailed) {
      logFailed = true;
      console.warn("[kronos] logging to kronos_calls failed:", err.message, "(rerun supabase/schema.sql to create the table)");
    }
  }
}

export function kronosEnabled() {
  return Boolean(KRONOS_SERVICE_URL);
}

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

export async function predictWithKronos(bars, meta = {}) {
  if (!KRONOS_SERVICE_URL || !Array.isArray(bars)) return null;
  const closes = bars.map((b) => Number(b?.c)).filter((c) => Number.isFinite(c) && c > 0);
  if (closes.length < MIN_CLOSES) return null;

  const horizon = Number(meta.horizonBars || 24);
  const lastClose = closes[closes.length - 1];

  try {
    const res = await fetch(`${KRONOS_SERVICE_URL}/forecast/closes`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(KRONOS_API_KEY ? { "x-api-key": KRONOS_API_KEY } : {}),
      },
      body: JSON.stringify({ closes: closes.slice(-512), horizon, samples: 10 }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || data.distribution_valid === false) return null;

    const pUp = clamp01(Number(data.probability_up ?? 0.5));
    const predicted = Number(data.mean_path?.[data.mean_path.length - 1]);
    const target = Number.isFinite(predicted) ? predicted : null;

    let signal = "HOLD";
    if (pUp >= 0.6) signal = "LONG";
    else if (pUp <= 0.4) signal = "SHORT";

    const move = target && lastClose ? ((target - lastClose) / lastClose) * 100 : 0;
    const confidence = clamp01(Math.abs(pUp - 0.5) * 2);

    logCall({
      device_id: meta.device_id ?? null,
      symbol: meta.symbol ?? null,
      horizon,
      sample_count: 10,
      model_version: String(data.model || ""),
      probability_up: pUp,
      confidence,
      signal,
      entry_price: lastClose,
      target_price: target,
      raw: data,
    });

    return {
      signal,
      probability: Number(pUp.toFixed(4)),
      confidence: Number(confidence.toFixed(3)),
      target_price: target,
      stop_price: null,
      horizon: "24h",
      reason: `Kronos sees a ${Math.round(pUp * 100)}% chance of a rise over the next ${horizon} bars (expected move ${move.toFixed(1)}%).`,
      model: String(data.model || "kronos").split("/").pop().toLowerCase(),
      basis: "kronos",
    };
  } catch {
    return null;
  }
}
