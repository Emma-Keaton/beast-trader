/**
 * Circuit breaker — the global kill switch.
 *
 * Adapted from `app/services/circuit_breaker.py` in E:\Projects\jasper-trades.
 * The idea worth keeping is that the breaker is a *separate* state machine from
 * the trading code: it can halt everything on its own authority, and nothing in
 * the order path can talk it out of it.
 *
 * Why this matters even in paper mode: an unattended system polls every 30
 * seconds with nobody watching. A data-source failure, a runaway loop or a
 * cascade of bad fills can all be detected and stopped automatically. The
 * alternative to this is not "we are careful", it is "we noticed".
 *
 * Trips on: drawdown from the equity high-water mark, a run of consecutive
 * losing trades, stale data (no fresh price), or a manual halt.
 */

export const STATE = { CLOSED: "closed", WARNING: "warning", OPEN: "open" };

/** Defaults. Conservative on purpose — this is a safety device, not a tuner. */
export const BREAKER_LIMITS = {
  maxDrawdown: 0.15, // 15% from the high-water mark
  maxConsecutiveLosses: 6,
  maxStaleMs: 15 * 60_000,
  warnConsecutiveLosses: 3,
  warnDrawdown: 0.08,
};

export class CircuitBreaker {
  constructor(opts = {}) {
    this.limits = { ...BREAKER_LIMITS, ...opts };
    this.state = STATE.CLOSED;
    this.reason = "";
    this.equity = null;
    this.peak = null;
    this.consecutiveLosses = 0;
    this.lastPriceAt = null;
    this.trippedAt = null;
    this.history = [];
  }

  /** Record a new equity value and re-evaluate. */
  updateEquity(value) {
    if (!Number.isFinite(value)) return this.state;
    this.equity = value;
    if (this.peak == null || value > this.peak) this.peak = value;
    return this.evaluate("drawdown");
  }

  /** Record a trade result: positive for a gain, negative for a loss. */
  recordTrade(pnl) {
    if (!Number.isFinite(pnl)) return this.state;
    if (pnl < 0) this.consecutiveLosses++;
    else if (pnl > 0) this.consecutiveLosses = 0;
    return this.evaluate("losing streak");
  }

  /** Record that a fresh price arrived, proving the data feed is alive. */
  recordPrice(at = Date.now()) {
    this.lastPriceAt = at;
    if (this.state === STATE.OPEN) return this.state; // a halt outranks a healthy feed
    return this.evaluate("stale data");
  }

  /**
   * Re-evaluate every condition. Any tripped condition halts, and the first
   * reason found is the one reported — so the message names a real cause rather
   * than a generic "something went wrong".
   */
  evaluate(trigger) {
    if (this.state === STATE.OPEN) return this.state;

    if (this.peak != null && this.equity != null && this.peak > 0) {
      const dd = 1 - this.equity / this.peak;
      if (dd >= this.limits.maxDrawdown) {
        this.trip(`equity fell ${(dd * 100).toFixed(1)}% from its high (limit ${(this.limits.maxDrawdown * 100).toFixed(0)}%)`);
        return this.state;
      }
      if (dd >= this.limits.warnDrawdown) this.warn(`drawdown ${(dd * 100).toFixed(1)}% is approaching the limit`);
    }

    if (this.consecutiveLosses >= this.limits.maxConsecutiveLosses) {
      this.trip(`${this.consecutiveLosses} losing trades in a row (limit ${this.limits.maxConsecutiveLosses})`);
      return this.state;
    }
    if (this.consecutiveLosses >= this.limits.warnConsecutiveLosses) {
      this.warn(`${this.consecutiveLosses} losing trades in a row`);
    }

    if (
      trigger === "stale data" &&
      this.lastPriceAt != null &&
      Date.now() - this.lastPriceAt > this.limits.maxStaleMs
    ) {
      const mins = Math.round((Date.now() - this.lastPriceAt) / 60_000);
      this.trip(`no fresh price for ${mins} minutes — the data feed has stopped`);
    }
    return this.state;
  }

  trip(reason) {
    if (this.state === STATE.OPEN) return;
    this.state = STATE.OPEN;
    this.reason = reason;
    this.trippedAt = Date.now();
    this.history.push({ at: this.trippedAt, event: "tripped", reason });
    console.warn(`[breaker] TRADING HALTED: ${reason}`);
  }

  warn(reason) {
    if (this.state === STATE.WARNING) return;
    this.state = STATE.WARNING;
    this.reason = reason;
    this.history.push({ at: Date.now(), event: "warning", reason });
  }

  /**
   * Resume trading. Deliberately a separate, explicit call.
   *
   * Never automatic and never self-clearing: a system that halted on a runaway
   * loss must not resume on its own authority, because whatever caused the halt
   * may still be present. This is a human decision, every time.
   */
  resume() {
    if (this.state !== STATE.OPEN) return false;
    this.state = STATE.CLOSED;
    this.history.push({ at: Date.now(), event: "resumed" });
    const wasTripped = this.trippedAt;
    this.trippedAt = null;
    this.consecutiveLosses = 0;
    // The peak is kept, not reset. Forgetting it would erase the drawdown that
    // caused the halt, and the same loss would then be allowed to happen again
    // immediately on the resumed run.
    this.reason = wasTripped ? "resumed after a halt" : "resumed";
    return true;
  }

  /** May a new order be placed? The only question the order path asks. */
  canTrade() {
    return this.state !== STATE.OPEN;
  }

  status() {
    const dd = this.peak && this.equity != null ? 1 - this.equity / this.peak : null;
    return {
      state: this.state,
      canTrade: this.canTrade(),
      reason: this.reason || "all checks normal",
      equity: this.equity,
      peak: this.peak,
      drawdown: dd == null ? null : Number(dd.toFixed(4)),
      consecutiveLosses: this.consecutiveLosses,
      lastPriceAt: this.lastPriceAt,
      limits: this.limits,
      trippedAt: this.trippedAt,
      history: this.history.slice(-10),
    };
  }

  /** Restore from persisted state so a restart does not silently clear a halt. */
  static from(snapshot) {
    const b = new CircuitBreaker(snapshot?.limits);
    Object.assign(b, {
      state: snapshot?.state ?? STATE.CLOSED,
      reason: snapshot?.reason ?? "",
      equity: snapshot?.equity ?? null,
      peak: snapshot?.peak ?? null,
      consecutiveLosses: snapshot?.consecutiveLosses ?? 0,
      lastPriceAt: snapshot?.lastPriceAt ?? null,
      trippedAt: snapshot?.trippedAt ?? null,
      history: snapshot?.history ?? [],
    });
    return b;
  }
}

/**
 * Process-wide breaker.
 *
 * A single instance is the point: a per-module breaker could be reset by
 * whichever module happened to hold it, and the kill switch would not be global.
 */
let instance = null;

export function getBreaker() {
  if (!instance) instance = new CircuitBreaker();
  return instance;
}

export function setBreaker(b) {
  instance = b;
  return instance;
}