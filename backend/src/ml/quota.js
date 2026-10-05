/**
 * Provider quota tracker.
 *
 * The DEX collectors are the first part of this app that spends a *metered*
 * resource: DexScreener allows 300 requests/minute on the pairs endpoints and
 * Helius allows 10 requests/second standard / 2 RPS DAS, with DAS calls costing
 * 10 credits against a 1,000,000 monthly credit allowance. Neither is enforced
 * by the provider in any way that is safe to discover by being suspended.
 *
 * So usage is tracked here, in-process, and a collector that would exceed its
 * budget DEGRADES instead of continuing: it drops to summary cadence rather than
 * burning quota. Degrading is the correct failure mode because the data is for
 * training — a sparser history still trains, a 429 does not.
 *
 * Pure and dependency-free so it can be tested without a network or a provider
 * key. `now` is injectable for exactly that reason.
 */

/** DexScreener, from the published API reference. */
export const LIMITS = {
  dexscreener: {
    pairsPerMinute: 300, // /token-pairs, /tokens, /search
    metaPerMinute: 60,   // /token-profiles, /token-boosts, /metas
  },
  helius: {
    standardPerSecond: 10,
    dasPerSecond: 2,
    dasCreditsEach: 10,
    monthlyCredits: 1_000_000,
  },
};

/**
 * A sliding-window counter for one budget.
 *
 * A sliding window rather than a fixed one because a fixed window lets a client
 * fire 2x the limit across a boundary (299 requests at 11:59:59 and 299 more at
 * 12:00:00) without ever tripping a naive per-minute check. This keeps the
 * timestamps of recent calls and drops those outside the window.
 */
class Window {
  #ms;
  #limit;
  #hits = [];

  constructor(ms, limit) {
    this.#ms = ms;
    this.#limit = limit;
  }

  /** Record a call. Returns false if it exceeded the budget (and does not count). */
  take(now = Date.now()) {
    const cutoff = now - this.#ms;
    while (this.#hits.length && this.#hits[0] <= cutoff) this.#hits.shift();
    if (this.#hits.length >= this.#limit) return false;
    this.#hits.push(now);
    return true;
  }

  used(now = Date.now()) {
    const cutoff = now - this.#ms;
    while (this.#hits.length && this.#hits[0] <= cutoff) this.#hits.shift();
    return this.#hits.length;
  }

  remaining(now = Date.now()) {
    return Math.max(0, this.#limit - this.used(now));
  }

  reset() {
    this.#hits = [];
  }
}

/**
 * Credit budget for a billing cycle, tracked locally.
 *
 * Helius' free allowance is 1,000,000 credits per month and DAS calls cost 10
 * each, so a sustained 2 RPS DAS poll would consume the entire month in roughly
 * 14 hours. Tracking it locally is what lets the collector back off before that
 * happens rather than after.
 *
 * LIMITATION, deliberately not papered over: this is in-memory only. A Render
 * spin-down resets `spent` to zero, which re-grants the full allowance on every
 * restart. That is a real over-count and is called out in quotaStatus() so it is
 * visible rather than assumed away; persisting the counter is deferred until
 * there is evidence the allowance is actually being reached.
 */
export class QuotaTracker {
  /**
   * @param {object} opts
   * @param {string} opts.name           provider name, for messages
   * @param {number} opts.monthlyCredits  credit allowance for the cycle
   * @param {Date}   [opts.cycleStart]   start of the current cycle
   */
  constructor({ name, monthlyCredits, cycleStart = null } = {}) {
    this.name = name;
    this.monthlyCredits = monthlyCredits ?? 0;
    this.cycleStart = cycleStart ?? new Date();
    this.spent = 0;
  }

  /** Is this a new billing cycle? Resets the allowance if so. */
  roll(now = new Date()) {
    // Modal/Modal-free providers bill monthly; approximating with 30 days from
    // first use keeps the tracker honest without needing a provider call.
    const days = (now - this.cycleStart) / 86_400_000;
    if (days >= 30) {
      this.cycleStart = now;
      this.spent = 0;
      return true;
    }
    return false;
  }

  /** Spend credits if affordable. Returns false when the allowance is exhausted. */
  spend(credits = 1, now = new Date()) {
    this.roll(now);
    if (this.spent + credits > this.monthlyCredits) return false;
    this.spent += credits;
    return true;
  }

  remaining(now = new Date()) {
    this.roll(now);
    return Math.max(0, this.monthlyCredits - this.spent);
  }

  /**
   * Fraction of the allowance used, 0..1. Drives the collector's cadence.
   *
   * Rolls the cycle first. Without that this reports the previous month's
   * fraction forever — a collector would throttle itself to a standstill on
   * the 1st of the month and never recover.
   */
  usedFraction(now = new Date()) {
    this.roll(now);
    if (this.monthlyCredits <= 0) return 1;
    return this.spent / this.monthlyCredits;
  }

  /**
   * Human-readable state for the dashboard and the health route.
   *
   * `in_memory_only` is surfaced rather than hidden. If this ever reads true in
   * production it means the credit count is not trustworthy across restarts, and
   * that should be visible instead of assumed.
   */
  status(now = new Date()) {
    return {
      provider: this.name,
      monthly_credits: this.monthlyCredits,
      spent: this.spent,
      remaining: this.remaining(now),
      used_fraction: Number(this.usedFraction(now).toFixed(4)),
      cycle_started: this.cycleStart.toISOString(),
      in_memory_only: true,
    };
  }
}

/**
 * The app-wide budgets.
 *
 * Headroom matters: the free DexScreener limit is 300/minute, and this runs at a
 * fraction of that deliberately. Running at exactly the limit guarantees a 429
 * the moment the app also makes a user-initiated request through the same
 * source, and a 429 during a trade decision is worse than a slightly sparser
 * history.
 */
export function createBudgets({ now = Date.now() } = {}) {
  return {
    dexscreenerPairs: new Window(60_000, LIMITS.dexscreener.pairsPerMinute - 20),
    dexscreenerMeta: new Window(60_000, LIMITS.dexscreener.metaPerMinute - 10),
    heliusStandard: new Window(1000, LIMITS.helius.standardPerSecond - 2),
    heliusDas: new Window(1000, LIMITS.helius.dasPerSecond - 1),
    credits: new QuotaTracker({ name: "helius", monthlyCredits: LIMITS.helius.monthlyCredits }),
    _now: now,
  };
}

/** Reset every window. Test seam. */
export function resetBudgets(budgets) {
  for (const v of Object.values(budgets)) {
    if (v instanceof Window) v.reset();
  }
}