/**
 * The trade gate — one chokepoint every order must pass.
 *
 * Adapted from `app/services/trade_gate.py` in E:\Projects\jasper-trades. The
 * design worth copying is that it is a *single* function every execution route
 * calls, and it returns a list of named checks with reasons rather than a bare
 * boolean. When an order is refused, the user is told which specific thing is
 * missing, not "trade rejected".
 *
 * That matters more than it sounds. With a poller, a manual trade button, a
 * reconnect flow and a scheduled rebalance all in one app, per-route checks
 * drift apart, and whichever route has the weakest checks becomes the way in.
 * Centralising it means a new execution path inherits the full set by
 * construction, rather than by remembering to re-implement it.
 *
 * Checks run cheapest-and-most-decisive first:
 *   1. circuit breaker open?     — the global kill switch
 *   2. sanity: side, amount, symbol
 *   3. mode is live              — paper is the default and stays that way
 *   4. a connected exchange
 *   5. the model is promoted     — no unproven model trades on its own
 *   6. position caps and daily loss limit
 *
 * The full set is returned even on success, so the UI can show what passed.
 */

import { getBreaker } from "../ml/circuit.js";
import { canAutoTrade } from "../ml/registry.js";
import { readCredentials, normaliseSymbol } from "./exchange.js";
import { getSettings } from "../store.js";
import { liveTradingEnabled } from "./executor.js";
import { riskProfile } from "../ml/riskprofile.js";
import { capabilities } from "./capabilities.js";

const add = (checks, name, passed, detail) => checks.push({ name, passed: Boolean(passed), detail });

/** Caps a live order must respect, overridable per device. */
export const DEFAULT_LIMITS = {
  maxOrderUsd: 100,
  maxTotalExposureUsd: 500,
  maxDailyLossUsd: 50,
  // Below this the fee eats the edge, so there is no point trading.
  minOrderUsd: 5,
};

/**
 * Evaluate every prerequisite for an order.
 *
 * @param ctx `{ deviceId, symbol, side, notionalUsd, intent, exchangeId,
 *               exposureUsd, realisedLossTodayUsd, modelBasis }`
 * @returns `{ allowed, checks, failures, limits }` — never throws, never partially applies
 */
export async function checkPrerequisites(ctx) {
  const checks = [];
  const {
    deviceId,
    symbol,
    side,
    notionalUsd,
    intent = "live",
    exchangeId,
    exposureUsd = 0,
    realisedLossTodayUsd = 0,
    modelBasis = "model",
  } = ctx;

  // 1. The kill switch first: nothing else matters while trading is halted.
  //    `breakerOverride` lets a per-chain executor supply its own breaker, so a
  //    halted Solana executor stops Solana without halting every other chain.
  //    It can only ever be *more* restrictive than the global one — an override
  //    can stop trading, never re-enable it.
  const breaker = ctx.breakerOverride ?? getBreaker();
  const globalBreaker = getBreaker();
  add(
    checks,
    "circuit_breaker",
    breaker.canTrade() && globalBreaker.canTrade(),
    breaker.canTrade() ? (globalBreaker.canTrade() ? "trading is allowed" : globalBreaker.reason) : breaker.reason,
  );

  // 2. Sanity. A malformed order is a bug, and bugs must never reach an exchange.
  const norm = normaliseSymbol(symbol);
  add(checks, "valid_symbol", Boolean(norm), norm ? `${norm} recognised` : `"${symbol}" is not a tradable pair`);
  add(checks, "valid_side", side === "buy" || side === "sell", "side must be buy or sell");
  add(
    checks,
    "valid_amount",
    Number.isFinite(notionalUsd) && notionalUsd > 0,
    "order value must be a positive number",
  );

  const settings = (await getSettings(deviceId).catch(() => null)) ?? {};
  /**
   * Limits come from three places, narrowest last.
   *
   * `risk_limits` is the user's explicit per-device override. The slider-derived
   * values sit below it so a slider move takes effect immediately without
   * discarding limits the user set by hand.
   *
   * Note the key translation. `applyProfile` emits the *settings* shape
   * (`max_order_usd`, snake_case), while the gate's `DEFAULT_LIMITS` are
   * camelCase. Spreading one into the other silently produced no effect at all —
   * the slider appeared to do nothing and the gate fell back to its defaults.
   * This is the one place both shapes meet, so the translation is explicit here
   * rather than made a shared helper, because the two vocabularies are genuinely
   * different things: one is persisted user configuration, the other is a
   * resolved runtime limit set.
   */
  const slider = Number.isFinite(settings.risk_level) ? riskProfile(settings.risk_level) : null;
  const limits = {
    ...DEFAULT_LIMITS,
    ...(slider
      ? {
          maxOrderUsd: slider.maxOrderUsd,
          minConfidence: slider.minConfidence,
          maxDailyLossUsd: slider.maxDailyLossUsd,
          // Total exposure is the sum of the per-trade cap and the open-position
          // count, so both sides of the slider constrain it. Exposure is the real
          // risk: five $500 trades is a very different account from one.
          maxTotalExposureUsd: Number((slider.maxOrderUsd * slider.maxOpenPositions).toFixed(2)),
        }
      : {}),
    ...(settings.risk_limits ?? {}),
  };

  if (intent === "live") {
    // 3. Mode. Paper is the default everywhere in this app and live is opt-in
    //    per device, so this can only fail closed.
    add(checks, "live_mode", settings.trading_mode === "live", "live trading must be switched on in Settings");

    /**
     * Whether the app can actually place an unattended order.
     *
     * Only the one combination that can: live + auto + a key the server holds.
     * `live + auto + wallet` has no signing capability at all today — a wallet key
     * cannot be signed server-side without session keys, which are not built. That
     * combination is refused rather than quietly downgraded, because "autonomous"
     * with no way to sign would otherwise mean the app silently places nothing
     * while appearing to run.
     */
    const caps = capabilities(settings);
    add(
      checks,
      "signing_capability",
      caps.canSignServerSide || caps.isAssisted,
      caps.canSignServerSide
        ? "the app can sign and place orders unattended"
        : caps.isAssisted
          ? "the app will propose trades for you to confirm"
          : "autonomous trading is selected but this setup cannot sign orders — use an exchange key, or switch to confirm-each-trade",
    );

    // 4. A connected exchange with stored credentials.
    add(checks, "exchange_selected", Boolean(exchangeId), "choose which exchange to trade on");
    if (exchangeId) {
      const creds = await readCredentials(deviceId, exchangeId).catch(() => null);
      /**
       * Assisted mode does not need credentials, and requiring them would be
       * actively wrong.
       *
       * The whole premise of assisted trading is that the key lives in the user's
       * wallet and never reaches this server. Demanding an API key here would
       * force exactly the thing the mode exists to avoid: handing a long-lived
       * trading credential to a server. So the check is replaced by "a wallet is
       * configured", which is what assisted mode genuinely requires.
       *
       * The trade-off is stated rather than hidden: assisted mode is slower and
       * needs the user present, and it deliberately cannot run unattended.
       */
      const assisted = settings.trade_style === "assisted";
      if (assisted) {
        add(
          checks,
          "wallet_configured",
          Boolean(settings.wallet_address),
          settings.wallet_address
            ? `wallet ${String(settings.wallet_address).slice(0, 6)}… will sign each trade`
            : "set your wallet address in Settings for assisted trading",
        );
      } else {
        add(
          checks,
          "exchange_connected",
          Boolean(creds),
          creds ? `${exchangeId} is connected` : `connect ${exchangeId} in Settings`,
        );
      }
    }

    // 5. The model gate. A model that has not been promoted may *suggest* a
    //    trade but never place one. This is the rule that stops an unproven
    //    model being trusted because it sounded confident.
    if (modelBasis === "model") {
      add(
        checks,
        "model_promoted",
        canAutoTrade(),
        canAutoTrade()
          ? "the active model has been validated"
          : "the active model has not been validated yet, so it will not trade on its own",
      );
    }

    // 6. Caps. Last, because these depend on the order's own numbers rather
    //    than on configuration.
    add(
      checks,
      "order_cap",
      notionalUsd <= limits.maxOrderUsd,
      `order ${fmt(notionalUsd)} is within the ${fmt(limits.maxOrderUsd)} per-trade cap`,
    );

    /**
     * The risk slider's confidence floor.
     *
     * The slider is a single control precisely so that position size and evidence
     * cannot be set incoherently — a bigger position demands a *higher* bar, not
     * a lower one. Enforced here rather than only in the planner so that no caller
     * can reach the venue with a size/conviction pairing the user never chose, and
     * so a refusal says which half of the trade was unacceptable.
     */
    const confidence = ctx.confidence;
    const floor = limits.minConfidence;
    if (Number.isFinite(confidence) && Number.isFinite(floor)) {
      add(
        checks,
        "risk_confidence_floor",
        confidence >= floor,
        confidence >= floor
          ? `confidence ${(confidence * 100).toFixed(0)}% clears your risk setting of ${(floor * 100).toFixed(0)}%`
          : `confidence ${(confidence * 100).toFixed(0)}% is below your risk setting of ${(floor * 100).toFixed(0)}% — move the risk slider down to accept it`,
      );
    }
    add(
      checks,
      "exposure_cap",
      exposureUsd + notionalUsd <= limits.maxTotalExposureUsd,
      `total exposure would be ${fmt(exposureUsd + notionalUsd)} against a ${fmt(limits.maxTotalExposureUsd)} cap`,
    );
    add(
      checks,
      "daily_loss_cap",
      -realisedLossTodayUsd < limits.maxDailyLossUsd,
      `today's realised loss is ${fmt(-realisedLossTodayUsd)} against a ${fmt(limits.maxDailyLossUsd)} limit`,
    );
    add(
      checks,
      "min_order",
      notionalUsd >= limits.minOrderUsd,
      `order of ${fmt(notionalUsd)} is above the ${fmt(limits.minOrderUsd)} minimum worth trading`,
    );
  }

  const failures = checks.filter((c) => !c.passed);
  return { allowed: failures.length === 0, checks, failures, limits };
}

/** Readable summary of what is blocking an order. */
export function describeFailures(result) {
  return (result?.failures ?? []).map((f) => `${f.name}: ${f.detail}`).join("; ");
}

function fmt(n) {
  return `$${Number(n ?? 0).toFixed(2)}`;
}

/**
 * Can this device switch from paper to live at all?
 *
 * A separate question from "may this order proceed", and deliberately stricter.
 * Switching modes is a one-way, hard-to-undo decision that changes what happens
 * to the user's money, so it gets its own explicit checklist rather than riding
 * along on per-order checks that a user never sees.
 */
export async function liveReadiness(deviceId) {
  const settings = (await getSettings(deviceId).catch(() => null)) ?? {};
  const checks = [];

  const breaker = getBreaker();
  add(checks, "breaker_closed", breaker.canTrade(), breaker.canTrade() ? "no active safety halt" : breaker.reason);

  /**
   * The deployment kill switch, surfaced here.
   *
   * This was missing, and its absence produced a genuinely dishonest UI: a device
   * could be told "you are ready, go live", switch to live, confirm with a modal
   * saying everything checks out, and then have every single order silently park
   * as `queued_live` because `liveTradingEnabled()` was false in the server
   * process. The user would have confirmed real-money trading on the strength of a
   * readiness report that never checked the thing that decided it.
   *
   * Readiness must answer the question the user is actually asking — "if I switch
   * now, will trades go through?" — not a related one.
   */
  add(
    checks,
    "live_enabled",
    liveTradingEnabled(),
    liveTradingEnabled()
      ? "this deployment is permitted to place real orders"
      : "live trading is disabled on the server (LIVE_TRADING_ENABLED)",
  );

  add(
    checks,
    "model_promoted",
    canAutoTrade(),
    canAutoTrade() ? "a model has passed the validation gate" : "no model has passed the validation gate yet",
  );

  const connected = [];
  for (const id of Object.keys(settings.exchanges ?? {})) {
    const c = await readCredentials(deviceId, id).catch(() => null);
    if (c) connected.push(id);
  }
  add(
    checks,
    "exchange_connected",
    connected.length > 0,
    connected.length ? `connected: ${connected.join(", ")}` : "connect an exchange in Settings first",
  );

  add(
    checks,
    "limits_configured",
    Boolean(settings.risk_limits),
    "set your risk limits so orders stay inside them",
  );

  return {
    ready: checks.every((c) => c.passed),
    checks,
    failures: checks.filter((c) => !c.passed),
    note:
      "Switching to live means real orders with real money. The limits above still apply, and the " +
      "app can still halt itself automatically if losses or stale prices cross its thresholds.",
  };
}

/**
 * Switch a device between paper and live.
 *
 * Refuses to switch *to* live unless every readiness check passes. Switching back
 * to paper is always allowed — that is the safe direction, and a user must never
 * be locked out of reducing their own risk.
 */
export async function setTradingMode(deviceId, mode) {
  if (mode !== "paper" && mode !== "live") {
    return { ok: false, reason: "mode must be paper or live" };
  }
  if (mode === "paper") {
    return { ok: true, mode, note: "switched to paper trading — no real orders will be sent" };
  }
  const readiness = await liveReadiness(deviceId);
  if (!readiness.ready) {
    return {
      ok: false,
      reason: "not ready for live trading yet",
      readiness,
    };
  }
  return { ok: true, mode, readiness };
}