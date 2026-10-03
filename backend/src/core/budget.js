/**
 * Monthly credit budget for metered APIs.
 *
 * Exists because a free-tier API key is a *shared, finite, monthly* resource,
 * and a bug should not be able to spend it. CoinMarketCap's Hobby plan allows
 * 10,000 calls a month; without a guard, one accidental tight loop can exhaust
 * that in an afternoon and leave the app dead until the calendar rolls over.
 *
 * The rule is simple and conservative: spend the key while there is budget,
 * and fall back to the free endpoint the moment there is not. Worst case the
 * app runs keyless for a few days. It never runs *out of data*, and it never
 * bills anyone.
 *
 * When the plan is upgraded, raise the budget in the environment:
 *   CMC_MONTHLY_CREDIT_BUDGET=100000
 */

import { config } from "../config.js";

/** Costs measured against the live CMC API: ceil(limit / 250), minimum 1. */
export function creditFor(path) {
  const limit = Number(new URL(path, "https://x").searchParams.get("limit") ?? 1);
  if (!Number.isFinite(limit) || limit <= 1) return 1;
  return Math.max(1, Math.ceil(limit / 250));
}

/** Credit allowance per plan. The free Hobby plan is 10,000. */
export const PLAN_CREDITS = {
  hobby: 10_000,
  basic: 50_000,
  professional: 200_000,
  business: 1_000_000,
};

/**
 * Credit accounting for a metered API, one calendar month at a time.
 *
 * Exported so the behaviour can be tested directly — a budget that is only
 * exercised in production is a budget that will be wrong in production.
 */
export class MonthlyBudget {
  /**
   * @param monthlyLimit  credits allowed per calendar month
   * @param headroomPct   fraction held back so a burst never reaches the cap
   */
  constructor(monthlyLimit, headroomPct = 0.2) {
    this.monthlyLimit = monthlyLimit;
    this.headroom = Math.floor(monthlyLimit * headroomPct);
    this.used = 0;
    this.month = currentMonth();
    this.keyDisabledUntil = 0;
    this.keyDisabledReason = null;
  }

  /**
   * Roll the counter over at the start of a new month.
   *
   * Called on every check rather than by a timer, so a process that sits idle
   * for weeks still resets correctly and cannot be stranded on a spent budget.
   */
  #roll() {
    const m = currentMonth();
    if (m !== this.month) {
      this.month = m;
      this.used = 0;
      this.keyDisabledUntil = 0;
      this.keyDisabledReason = null;
    }
  }

  /** Effective ceiling: the plan's limit minus the held-back headroom. */
  get ceiling() {
    return Math.max(0, this.monthlyLimit - this.headroom);
  }

  get remaining() {
    return Math.max(0, this.ceiling - this.used);
  }

  /** True while the key is still usable this month. */
  canSpend() {
    this.#roll();
    if (Date.now() < this.keyDisabledUntil) return false;
    return this.remaining > 0;
  }

  /**
   * Record spend.
   *
   * Charged only on a *successful* keyed call, so a failing key cannot drain
   * the allowance — CMC does not bill rejected requests, and neither do we.
   */
  spend(credits) {
    this.#roll();
    this.used += Math.max(0, credits);
    return this.used;
  }

  /**
   * Stop using the key until next month after a hard rejection.
   *
   * A wrong or revoked key returns the same 401 on every request, so without
   * this the app would retry it forever and log on every single call.
   */
  disableKey(reason) {
    this.keyDisabledReason = reason;
    // Retry next month rather than never: the key may be fixed by then.
    this.keyDisabledUntil = nextMonthStart();
  }

  state() {
    this.#roll();
    return {
      plan_month: this.month,
      monthly_limit: this.monthlyLimit,
      ceiling: this.ceiling,
      used: this.used,
      remaining: this.remaining,
      key_disabled: Date.now() < this.keyDisabledUntil,
      key_disabled_reason: Date.now() < this.keyDisabledUntil ? this.keyDisabledReason : null,
    };
  }
}

/** "2026-09" — the billing period key. */
function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

function nextMonthStart() {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

export const cmcBudget = new MonthlyBudget(config.cmcMonthlyCreditBudget);
