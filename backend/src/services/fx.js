/**
 * Live foreign-exchange rates.
 *
 * Prices are stored and computed in USD because every crypto feed quotes USD.
 * This module turns that into whatever the reader thinks in, without ever
 * converting the stored value: the rate multiplies at display time, so
 * switching currency cannot corrupt a price, a stop, or a P&L figure.
 *
 * `open.er-api.com` is keyless, CORS-friendly and updates daily. Its NGN rate
 * is a mid-market reference, not a bank or bureau rate — a reader comparing it
 * to what their local bureau actually offers will be a few percent apart, and
 * the UI says so rather than pretending otherwise.
 *
 * An optional `FX_API_KEY` is accepted for a higher-tier provider but is not
 * required, and is not used unless present.
 */

import { TtlCache } from "../core/cache.js";
import { getJSON, SoftError } from "../core/http.js";
import { config } from "../config.js";

const cache = new TtlCache({ max: 50, name: "fx" });

const OPEN_ER = "https://open.er-api.com/v6/latest/USD";

// Forex rates move on the order of 0.1% a day, so a long cache is safe and
// keeps this off the critical path of every page load.
const TTL_FX = 6 * 3600_000;

/**
 * Fail-soft wrapper: a market-data outage must degrade, never throw. A 429 or
 * an open breaker is an expected condition here, not an error.
 */
async function soft(fn, fallback) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof SoftError || err?.soft) return fallback;
    console.warn(`[fx] ${err?.message || err}`);
    return fallback;
  }
}

/** Currencies the UI offers. Anything else the provider returns is ignored. */
export const SUPPORTED = ["USD", "NGN", "EUR", "GBP", "JPY", "ZAR", "KES", "INR", "CAD", "AUD"];

/**
 * Conversion rates as "units of this currency per 1 USD".
 *
 * NGN is quoted this way by every provider (1 USD = 1327 NGN), which is
 * exactly the direction needed here: `display = usd * rate`. Inverting it
 * would make a ₦1327 coin price out at $0.0007, so the convention is stated
 * once here and never re-derived at a call site.
 */
export function fxRates() {
  return cache.fetch("fx:usd", async () => {
    const j = await soft(() => getJSON(OPEN_ER, { timeoutMs: 8000, retries: 1 }), null);
    const raw = j?.rates;
    if (!raw) return null;

    const out = { USD: 1 };
    for (const c of SUPPORTED) {
      if (c === "USD") continue;
      const perUsd = Number(raw[c]);
      if (Number.isFinite(perUsd) && perUsd > 0) out[c] = perUsd;
    }

    return {
      rates: out,
      updated: j?.time_last_update_utc ?? new Date().toISOString(),
      // What the reader needs to know to trust the number.
      source: "open.er-api.com (mid-market reference)",
      source_is_keyed: Boolean(config.fxApiKey),
    };
  }, TTL_FX);
}

/**
 * Convert a USD amount for display.
 *
 * Falls back to identity rather than throwing: a converter outage must not
 * take the price page down with it. The UI shows prices in USD and says the
 * rate is unavailable, which is a far better failure than blank prices.
 */
export async function convert(usd, currency = "USD") {
  if (!Number.isFinite(usd)) return null;
  if (currency === "USD") return { value: usd, currency: "USD", rate: 1, available: true };
  const fx = await fxRates();
  const rate = fx?.rates?.[currency];
  if (!Number.isFinite(rate)) return { value: usd, currency: "USD", rate: 1, available: false };
  return { value: usd * rate, currency, rate, available: true, updated: fx.updated };
}