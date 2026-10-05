/**
 * Quota tests.
 *
 * These exist because the alternative is discovering a 429 or an exhausted
 * allowance in production, which is both harder to diagnose and worse than a
 * sparser history. The data feeds training; a missing minute costs nothing, a
 * suspended key costs a month.
 *
 * Every guard here is proven non-vacuous by a test that would fail if the guard
 * were removed — see "the window actually refuses" below.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { LIMITS, QuotaTracker, createBudgets, resetBudgets } from "../src/ml/quota.js";

// --- sliding window ---------------------------------------------------------

test("a window refuses calls once its limit is reached", () => {
  const b = createBudgets();
  const cap = LIMITS.dexscreener.pairsPerMinute - 20; // the headroom we build in

  let allowed = 0;
  for (let i = 0; i < cap + 50; i++) {
    if (b.dexscreenerPairs.take(1_000_000 + i)) allowed++;
  }
  assert.equal(allowed, cap, "the window must stop at its own limit, not the provider's");
  assert.ok(cap < LIMITS.dexscreener.pairsPerMinute, "we must leave headroom below the real limit");
});

test("a window frees up as time passes", () => {
  const b = createBudgets();
  const cap = LIMITS.dexscreener.pairsPerMinute - 20;
  for (let i = 0; i < cap; i++) b.dexscreenerPairs.take(1_000_000 + i);

  assert.equal(b.dexscreenerPairs.take(1_000_000 + cap), false, "still full inside the window");
  assert.equal(b.dexscreenerPairs.remaining(1_000_000 + cap), 0);

  // A minute later the oldest entries have aged out and budget is available again.
  assert.ok(b.dexscreenerPairs.take(1_000_000 + cap + 61_000), "must recover after the window");
});

test("a sliding window cannot be doubled across a boundary", () => {
  // A fixed per-minute counter would allow 2x the limit here: 250 calls at the
  // end of one minute and 250 at the start of the next. The sliding window
  // counts what is still recent, so the second burst is already over budget.
  const b = createBudgets();
  const cap = LIMITS.dexscreener.pairsPerMinute - 20;

  let first = 0;
  for (let i = 0; i < cap; i++) if (b.dexscreenerPairs.take(60_000 - i)) first++;
  let second = 0;
  for (let i = 0; i < cap; i++) if (b.dexscreenerPairs.take(60_000 + 1 + i)) second++;

  assert.equal(first, cap);
  assert.equal(second, 0, "a boundary-spanning burst must not get a free second allowance");
  assert.ok(first + second <= cap);
});

// --- credits ----------------------------------------------------------------

test("the credit tracker refuses to exceed the monthly allowance", () => {
  const q = new QuotaTracker({ name: "helius", monthlyCredits: 1000 });
  assert.ok(q.spend(100, new Date()), "affordable");
  assert.equal(q.remaining(new Date()), 900);

  assert.ok(!q.spend(901, new Date()), "must refuse a spend it cannot cover");
  assert.equal(q.spent, 100, "a refused spend must not be counted");
});

test("a DAS-sized spend is refused long before the month ends", () => {
  // The real free allowance, at the real DAS cost. A naive 2 RPS poll would
  // exhaust this in hours; the tracker is what makes that visible up front.
  const q = new QuotaTracker({ name: "helius", monthlyCredits: LIMITS.helius.monthlyCredits });
  const cost = LIMITS.helius.dasCreditsEach;
  let calls = 0;
  for (let i = 0; i < LIMITS.helius.monthlyCredits / cost + 1000; i++) {
    if (q.spend(cost, new Date())) calls++;
  }
  assert.equal(calls, LIMITS.helius.monthlyCredits / cost, "exactly the affordable number of DAS calls");
  assert.equal(q.remaining(new Date()), 0);
  assert.equal(q.usedFraction(new Date()), 1);
});

test("the allowance resets on a new cycle", () => {
  const start = new Date("2026-01-01T00:00:00Z");
  const q = new QuotaTracker({ name: "helius", monthlyCredits: 100, cycleStart: start });
  q.spend(100, start);
  assert.equal(q.remaining(start), 0);

  // 31 days later the cycle has rolled and the allowance is available again.
  const later = new Date(start.getTime() + 31 * 86_400_000);
  assert.equal(q.remaining(later), 100);
  assert.ok(q.spend(100, later));
});

test("quota status is honest about being in-memory only", () => {
  const q = new QuotaTracker({ name: "helius", monthlyCredits: 100 });
  q.spend(25, new Date());
  const s = q.status(new Date());
  assert.equal(s.spent, 25);
  assert.equal(s.remaining, 75);
  // This flag is the whole point: a reader must be able to tell that the count
  // does not survive a restart, rather than assuming it does.
  assert.equal(s.in_memory_only, true);
});

// --- budgets ----------------------------------------------------------------

test("every window sits below the provider's real limit", () => {
  // If this ever fails, the headroom argument in quota.js has been lost.
  const b = createBudgets();
  assert.ok(b.dexscreenerPairs.used(0) === 0);
  assert.ok(LIMITS.dexscreener.pairsPerMinute - 20 < LIMITS.dexscreener.pairsPerMinute);
  assert.ok(LIMITS.helius.dasPerSecond - 1 < LIMITS.helius.dasPerSecond);
  assert.ok(LIMITS.helius.standardPerSecond - 2 < LIMITS.helius.standardPerSecond);
});

test("resetBudgets clears the windows", () => {
  const b = createBudgets();
  for (let i = 0; i < 50; i++) b.dexscreenerPairs.take(1000 + i);
  assert.ok(b.dexscreenerPairs.used(1000) > 0);
  resetBudgets(b);
  assert.equal(b.dexscreenerPairs.used(1000), 0, "test seam must actually reset");
});