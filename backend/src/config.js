import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Tiny .env loader (no dependency) — loads backend/.env then repo-root .env
function loadEnv(file) {
  try {
    const txt = fs.readFileSync(file, "utf8");
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    /* file optional */
  }
}
loadEnv(path.join(__dirname, "..", ".env"));
loadEnv(path.join(__dirname, "..", "..", ".env"));

export const config = {
  port: Number(process.env.PORT || 8787),
  jwtSecret: process.env.JWT_SECRET || crypto.randomBytes(32).toString("hex"),
  jwtTtlDays: 30,
  supabaseUrl: process.env.SUPABASE_URL || "",
  supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 30_000),
  refreshThrottleMs: Number(process.env.REFRESH_THROTTLE_MS || 15_000),
  // How often the app re-evaluates its models against settled paper calls.
  // Deliberately slow: each cycle may retrain, and retraining is far more
  // expensive than a poll. Six hours also keeps it well clear of the cooldown
  // in retrain.js.
  improveIntervalMs: Number(process.env.IMPROVE_INTERVAL_MS || 6 * 3600_000),
  // The auto-executor sweeps every chain's top performers. Slower than the
  // 30s market poller on purpose: a sweep costs real API quota across eight
  // chains, and a candidate worth buying now is usually still worth buying in
  // ten minutes. Scanning faster burns the rate limit and duplicates decisions.
  autoExecIntervalMs: Number(process.env.AUTOEXEC_INTERVAL_MS || 10 * 60_000),
  tradingMode: process.env.TRADING_MODE === "live" ? "live" : "paper",
  coingeckoKey: process.env.COINGECKO_API_KEY || "",
  // Optional. When set, CoinMarketCap is queried on the official keyed Pro API
  // (higher rate limits, cleaner data). When absent — or once the monthly
  // credit budget is spent — the keyless public API is used instead, so the app
  // is fully functional either way and the free key cannot be exhausted.
  cmcApiKey: process.env.CMC_API_KEY || "",
  // Credits per month this key may spend. The free Hobby plan allows 10,000;
  // the default leaves 20% headroom. Raise it when you upgrade the plan.
  cmcMonthlyCreditBudget: Number(process.env.CMC_MONTHLY_CREDIT_BUDGET || 10_000),
  fxApiKey: process.env.FX_API_KEY || "",
  autoTradeMinConfidence: Number(process.env.AUTO_TRADE_MIN_CONFIDENCE || 0.65),
  maxOrderUsd: Number(process.env.MAX_ORDER_USD || 100),
  /**
   * Which venue live orders go to when a plan does not name one.
   *
   * `exchange.js` supports several (`SUPPORTED_EXCHANGES`); this picks the
   * deployment default so a single-venue setup needs no per-order plumbing.
   * A plan carrying its own `exchange_id` always wins.
   */
  exchangeId: process.env.EXCHANGE_ID || "binance",
  /**
   * Which network live orders go to: "mainnet" (real funds) or "testnet".
   *
   * Mainnet is the default as requested. It is only ever consulted for orders
   * that have already cleared the promotion gate, the per-device consent, the
   * deployment kill switch and the trade gate — this setting chooses *where*
   * a permitted trade executes, it does not decide whether it may exist.
   */
  network: process.env.NETWORK === "testnet" ? "testnet" : "mainnet",
  /**
   * Where local JSON state lives: store.json, the model, scoreboard, strategies
   * and cached history.
   *
   * Overridable so the test suite can point somewhere disposable. Without this,
   * tests wrote into the same `backend/data/` a running server uses — so a test
   * run could corrupt a real paper track record, and a leftover entry from an
   * interrupted run (a half-written challengers.json) failed the *next* run with
   * a misleading assertion error. `.env.test` sets DATA_DIR to `.test-data`.
   *
   * A relative DATA_DIR resolves against the backend root, not the process cwd,
   * so `npm test` and `node --test tests/x.js` land in the same place.
   */
  dataDir: process.env.DATA_DIR
    ? path.resolve(path.join(__dirname, ".."), process.env.DATA_DIR)
    : path.join(__dirname, "..", "data"),
};

export const usingSupabase = Boolean(config.supabaseUrl && config.supabaseKey);
