import { config } from "../config.js";
import { canAutoTrade } from "../ml/registry.js";
import { sizePosition } from "../ml/sizing.js";
import { checkPrerequisites, describeFailures } from "./gate.js";
import { placeOrder } from "./exchange.js";
import { resolveHorizonMs } from "../ml/paper.js";
import { insertRow, listCollection, updateRow } from "../store.js";

/**
 * Deployment-level switch for real-money execution.
 *
 * Deliberately read from the environment on every call rather than captured once
 * at import, so flipping it does not require a restart to take effect — the
 * person who turns it on should not have to redeploy to believe it worked, and
 * the person who turns it off should not have to wait for a rolling restart to
 * be believed.
 *
 * Absent or anything other than the exact string "true" means off. A typo like
 * "1" or "yes" fails closed, which is the correct direction for a flag whose
 * absence permits money to move.
 */
export function liveTradingEnabled() {
  return String(process.env.LIVE_TRADING_ENABLED ?? "").trim().toLowerCase() === "true";
}

/**
 * Execution planner + order executor.
 *
 * Paper mode (default): orders are simulated fills booked at market price —
 * the full loop research -> prediction -> plan -> execute -> log runs with
 * zero capital at risk.
 *
 * Live mode hooks (documented, not auto-called until keys + wallet signing
 * are configured per device):
 *   - CEX  : Binance/COINBASE signed REST call using the device's encrypted
 *            api_key/secret from device_settings (store.decryptSecret).
 *   - DEX  : Solana via Jupiter /swap + wallet signature (client-side),
 *            EVM via WalletConnect sessions.
 */

// How long a filled paper order is held before it is marked to market.
//
// Sourced from the shared horizon registry rather than repeated here, because two
// independent copies of "how long is a bar worth" is precisely the bug that made
// this 3 hours when a bar is a day. `ORDER_HORIZON_MS` remains exported as the
// entry-horizon default for callers that do not know their basis.
export const ORDER_HORIZON_MS = resolveHorizonMs("model");
export function planOrder(snapshot, prediction, risk) {
  if (!snapshot.price_usd || prediction.signal === "HOLD") return null;
  const cap = risk?.max_order_usd ?? config.maxOrderUsd;
  const budget = Math.min(cap, config.maxOrderUsd);
  const side = prediction.signal === "LONG" ? "BUY" : "SELL";

  // Continuous sizing: a 70%-confident call gets more size than a 56% one.
  // Falling back to the full budget when no probability is available keeps
  // manual trades working, where confidence is supplied by the user.
  let notional = budget;
  if (Number.isFinite(prediction.probability)) {
    const sized = sizePosition(prediction.probability, {
      maxNotional: budget,
      turbulence: prediction.turbulence ?? 0,
      threshold: risk?.turbulence_threshold ?? 3,
    });
    notional = sized.notional;
    // Parentheses matter: `a < b ?? c` parses as `(a < b) ?? c`, which is
    // always truthy and would reject every order.
    if (notional < (risk?.min_order_usd ?? 5)) return null; // too small to be worth the fee
  }

  const qty = Number((notional / snapshot.price_usd).toFixed(8));
  if (!qty || qty <= 0) return null;
  // Prefer the model's own protective stop; fall back to a flat 5% if the
  // prediction tier didn't produce one.
  const stop = Number(
    (prediction.stop_price ?? snapshot.price_usd * (prediction.signal === "LONG" ? 0.95 : 1.05)).toFixed(8),
  );
  return {
    symbol: snapshot.symbol,
    chain: snapshot.chain || "coingecko",
    venue: snapshot.source === "dexscreener" ? "dex" : "cex",
    side,
    qty,
    notional_usd: notional,
    limit_price: snapshot.price_usd,
    stop_loss: stop,
    take_profit: prediction.target_price ?? null,
    confidence: prediction.confidence,
    rationale: prediction.reason ?? prediction.rationale ?? "",
    model: prediction.model ?? "unknown",
    // Carried onto the order so an executed trade is trainable later. The
    // vector is captured at decision time, before the outcome is known, which
    // is the only version of it worth learning from.
    probability: Number.isFinite(prediction.probability) ? prediction.probability : null,
    features: Array.isArray(prediction.features) ? prediction.features : null,
    mode: risk?.trading_mode || config.tradingMode,
  };
}

/**
 * Execute a planned order.
 *
 * Paper (the default) books a simulated fill at market and marks it to market
 * after the horizon.
 *
 * Live dispatches to `exchange.placeOrder()`, which already speaks signed
 * Binance/Coinbase and validates symbol, amount, price and step size. This
 * function did not previously call it — live orders were parked as
 * `queued_live` with a note that connectors were pending. They were not; the
 * connector layer in `exchange.js` existed the whole time and was simply never
 * called. That gap is closed here, behind the guards below.
 *
 * Refuses rather than degrades, in this order:
 *  1. `plan.mode` must be live at all.
 *  2. The trade gate must have passed — this function is not the gate, and
 *     callers are expected to have run `checkPrerequisites()`. Auto-exec does.
 *  3. `LIVE_TRADING_ENABLED` must be set in the environment. A second, deliberate
 *     switch *in the server process*, separate from the per-device mode. The
 *     device mode says "this user consented"; this says "this deployment is
 *     allowed to move money at all". A compromised or misconfigured client
 *     cannot enable it, and a local demo of the app cannot reach a real account.
 *  4. **The network is chosen by config, not by a code edit.** `NETWORK=mainnet`
 *     is the default as requested; `NETWORK=testnet` moves the same connector to
 *     a venue sandbox without touching code. This replaced a hardcoded
 *     testnet-first default. It is deliberately the *weakest* of the four locks:
 *     an env var can be changed by anyone with deployment access, so it must not
 *     be the thing standing between a mistake and real money — the other three
 *     still do.
 */
export async function executeOrder(deviceId, plan, opts = {}) {
  if (!plan) return null;

  if (plan.mode === "live") {
    // Gate 3: deployment-level kill switch.
    if (!liveTradingEnabled()) {
      return insertRow("orders", {
        device_id: deviceId,
        ...plan,
        status: "queued_live",
        note: "live execution disabled — set LIVE_TRADING_ENABLED=true on the server to allow real orders",
      });
    }
    // Gate 2: the single chokepoint every order must pass.
    const gate = await checkPrerequisites({
      deviceId,
      symbol: plan.symbol,
      side: plan.side === "BUY" ? "buy" : "sell",
      notionalUsd: plan.notional_usd ?? 0,
      intent: "live",
      modelBasis: plan.model_basis,
    });
    if (!gate.allowed) {
      // Booked, not dropped: an order the user can see and understand is far
      // more useful than a silent no-op when something blocks trading.
      return insertRow("orders", {
        device_id: deviceId,
        ...plan,
        status: "blocked",
        note: `trade gate refused: ${describeFailures(gate)}`,
      });
    }
    // Gate 4: which network. Mainnet by default, overridable via config.
    // `opts.testnet` if the caller explicitly chose; otherwise follow config.
    //
    // The previous expression was `opts.testnet !== undefined ? opts.testnet !==
    // true : ...`, which inverted the explicit case: passing `testnet: true`
    // yielded mainnet and passing `testnet: false` yielded testnet. Omitting the
    // option — the common case — was correct, which is why nothing had surfaced.
    const testnet = opts.testnet !== undefined ? Boolean(opts.testnet) : config.network !== "mainnet";
    const result = await placeOrder(deviceId, plan.exchange_id ?? config.exchangeId, plan, {
      allowLive: true,
      breakerCanTrade: gate.checks.find((c) => c.name === "circuit_breaker")?.passed ?? false,
      allowMarket: Boolean(opts.allowMarket),
      testnet,
    });
    return insertRow("orders", {
      device_id: deviceId,
      ...plan,
      status: result?.ok ? "filled_live" : "live_failed",
      filled_price: result?.price ?? null,
      venue_order_id: result?.orderId ?? null,
      testnet,
      note: result?.ok
        ? `filled on ${testnet ? "testnet" : "MAINNET"}`
        : `exchange refused: ${result?.reason ?? "unknown error"}`,
    });
  }

  const fillPrice = plan.limit_price;
  // When this position is marked to market. Without it the order is a display
  // row forever — no outcome, so nothing to train on, and no realised P&L.
  const dueAt = new Date(Date.now() + (plan.horizon_ms ?? ORDER_HORIZON_MS)).toISOString();
  return insertRow("orders", {
    device_id: deviceId,
    ...plan,
    status: "filled_paper",
    filled_price: fillPrice,
    filled_at: new Date().toISOString(),
    pnl_usd: 0,
    due_at: dueAt,
  });
}

/**
 * Mark filled orders to market and record their outcome.
 *
 * Paper calls have their own ledger (`paper.js`), which is what the retrainer
 * has always learned from. That leaves executed orders as a display log with no
 * outcome at all — so the trades the app actually placed, at the sizes and
 * prices it actually used, never reached training.
 *
 * Settling them closes that gap: an order becomes a labelled example with a
 * real fill and real fees, which is strictly better evidence than a synthetic
 * call at the same moment.
 *
 * Only paper-filled orders are settled. `queued_live` rows are parked pending
 * connectors and must never be marked, or the ledger would invent trades that
 * were never sent.
 *
 * @param pricesFn `(symbol) => number|null` — usually the live quote
 * @returns the number of orders settled this run
 */
export async function settleOrders(deviceId, pricesFn) {
  const orders = await listCollection("orders", deviceId, "created_at.desc");
  const now = Date.now();
  let settled = 0;

  for (const o of orders) {
    // Parked live orders have no fill and no position; there is nothing to mark.
    if (!String(o.status ?? "").startsWith("filled_")) continue;
    if (o.settled_at) continue;
    if (!o.due_at || new Date(o.due_at).getTime() > now) continue;
    const entry = Number(o.filled_price ?? o.limit_price);
    if (!Number.isFinite(entry) || entry <= 0) continue;

    const exit = await pricesFn(o.symbol);
    if (!exit) continue;

    const dir = o.side === "BUY" ? 1 : -1;
    // Same 0.1% taker fee a real venue charges, so a settled order and a settled
    // paper call are measured on identical terms and can share a training set.
    const net = dir * (exit / entry - 1) - 0.002;
    const pnlUsd = Number.isFinite(o.notional_usd) ? o.notional_usd * net : 0;

    try {
      await updateRow("orders", o.id, {
        status: "settled",
        exit_price: exit,
        pnl_pct: Number(net.toFixed(6)),
        pnl_usd: Number(pnlUsd.toFixed(6)),
        settled_at: new Date().toISOString(),
      });
      settled++;
    } catch (err) {
      // One failed write must not abort the sweep; retried on the next tick.
      console.warn("[executor] settle persist failed:", err.message);
    }
  }
  return settled;
}

/**
 * Auto-trade on the user's own watchlist: confident signal + autopilot on.
 *
 * This previously called `executeOrder` directly. It checked model promotion
 * and a confidence threshold, but **not** the circuit breaker, the per-order
 * cap, exposure, or the daily loss limit — so the poller's path around the gate
 * was the weakest link in the whole safety chain, and a poller running
 * unattended is exactly the case where that matters.
 *
 * It now routes through `checkPrerequisites` like every other order path. The
 * extra checks are cheap, and a watchlist trade gets no special exemption from
 * the limits that a manual trade has to respect.
 */
export async function maybeAutoTrade(deviceId, snapshot, prediction, settings) {
  // A model that has not passed its promotion gate never places a trade on its
  // own, however confident it sounds. This remains the first and most important
  // rule, and it is now also enforced inside the gate below.
  if (prediction.basis === "model" && !canAutoTrade()) return null;

  const min = settings?.auto_trade_min_confidence ?? config.autoTradeMinConfidence;
  if (!settings?.autopilot || prediction.confidence < min) return null;
  const recent = await listCollection("orders", deviceId, "created_at.desc");
  const since = Date.now() - 6 * 3600_000;
  if (recent.some((o) => o.symbol === snapshot.symbol && new Date(o.created_at) > since)) return null; // 1 order / symbol / 6h

  const plan = planOrder(snapshot, prediction, settings);
  if (!plan) return null;

  const mode = settings?.trading_mode === "live" ? "live" : "paper";
  const gate = await checkPrerequisites({
    deviceId,
    symbol: plan.symbol,
    side: plan.side === "BUY" ? "buy" : "sell",
    notionalUsd: plan.notional_usd,
    intent: mode,
    exchangeId: settings?.exchange_id,
    modelBasis: prediction.basis,
  });
  if (!gate.allowed) {
    // Logged, not silent: a watchlist that stops trading should say why.
    console.warn(`[executor] auto-trade blocked for ${plan.symbol}: ${gate.failures.map((f) => f.name).join(", ")}`);
    return null;
  }

  return executeOrder(deviceId, plan);
}
