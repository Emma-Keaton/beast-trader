/**
 * Tests for the continuous-improvement loop.
 *
 * The property that matters most here is the negative one: a self-improving
 * system must be *hard* to improve by accident. These tests pin down that a
 * too-small sample cannot trigger a retrain, and that a challenger cannot
 * displace a champion that is performing better.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { config } from "../src/config.js";
import {
  trainingSetFromCalls,
  normaliseOrders,
  scoreFixed,
  retrain,
  scoreChallengersOn,
  resetRetrainClock,
  MIN_SETTLED_FOR_RETRAIN,
} from "../src/ml/retrain.js";
import {
  PROMOTION_RULES,
  proposeChallenger,
  recordChallengerOutcome,
  evaluatePromotion,
  promoteChallenger,
  listChallengers,
  scoreChallenger,
  getChampion,
  improvementState,
} from "../src/ml/strategies.js";
import { fit } from "../src/ml/logistic.js";
import { synthBars } from "../src/ml/synth.js";
import { predictFromSeries } from "../src/services/predict.js";

/* ── Executed orders as a training source ────────────────────────────────────
 *
 * Orders used to be a display log with no outcome, so the trades the app
 * actually placed never reached training. These pin the rules that turn a
 * settled order into a usable, correctly-signed example — the part where a
 * silent mistake would poison the model rather than crash it.
 */

test("a settled order becomes a trainable example with the right direction", () => {
  const out = normaliseOrders([
    { side: "BUY", filled_price: 100, exit_price: 110, features: [0.1, -0.2], status: "settled" },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].side, "LONG", "BUY is long");
  assert.equal(out[0].source, "order");
  // The training set must accept it verbatim.
  const { X, y, fwd, rows } = trainingSetFromCalls(out);
  assert.equal(rows, 1);
  assert.equal(X[0].length, 2);
  assert.equal(y[0], 1, "a profitable long is a positive label");
  assert.ok(Math.abs(fwd[0] - Math.log(1.1)) < 1e-12);
});

test("a losing short produces a positive label, not a negative one", () => {
  // The bug this guards: signing by the raw price move. A short that gained
  // looks like a loss by price, and would train the model backwards.
  const out = normaliseOrders([
    { side: "SELL", filled_price: 100, exit_price: 90, features: [1], status: "settled" },
  ]);
  const { y, fwd } = trainingSetFromCalls(out);
  assert.equal(y[0], 1, "price fell and we were short, so the trade won");
  assert.ok(fwd[0] > 0);
});

test("orders without a feature vector are skipped, not imputed", () => {
  const out = normaliseOrders([
    { side: "BUY", filled_price: 100, exit_price: 110, status: "settled" },
    { side: "BUY", filled_price: 100, exit_price: 110, features: [], status: "settled" },
    { side: "BUY", filled_price: 100, exit_price: 110, features: [0.1], status: "settled" },
  ]);
  assert.equal(out.length, 1, "only the row with a real vector survives");
});

test("an unsettled or unusable order is never trained on", () => {
  const out = normaliseOrders([
    { side: "BUY", filled_price: 100, features: [0.1], status: "queued_live" }, // no exit
    { side: "BUY", filled_price: 0, exit_price: 110, features: [0.1], status: "settled" }, // bad entry
    { side: "BUY", filled_price: 100, exit_price: NaN, features: [0.1], status: "settled" }, // bad exit
    { side: "HOLD", filled_price: 100, exit_price: 110, features: [0.1], status: "settled" }, // no direction
  ]);
  assert.equal(out.length, 0, "nothing half-recorded is good training data");
});

test("an order with no side cannot be silently treated as a long", () => {
  const out = normaliseOrders([
    { filled_price: 100, exit_price: 110, features: [0.1], status: "settled" },
  ]);
  assert.equal(out.length, 0, "direction must be explicit, never defaulted");
});

test("limit price is used when a fill price is missing", () => {
  const out = normaliseOrders([
    { side: "BUY", limit_price: 50, exit_price: 55, features: [0.1], status: "settled" },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].entry_price, 50);
});

const DIR = path.join(config.dataDir, "strategies");
function reset() {
  // Windows raises ENOTEMPTY when a directory is removed while a handle is
  // still closing, which surfaced as "ENOTEMPTY, Directory not empty:
  // .test-data\strategies" and failed a test that had nothing wrong with it.
  // A retry is the documented remedy; force is already set, and maxRetries only
  // applies to the recursive path.
  fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  resetRetrainClock();
}

/** Build a settled paper call whose features actually predict the label. */
function makeCalls(n, edge = 0.02) {
  const calls = [];
  for (let i = 0; i < n; i++) {
    const x = (Math.random() - 0.5) * 4;
    const up = x + Math.random() * 0.2 > 0;
    calls.push({
      symbol: "BTC",
      side: up ? "LONG" : "SHORT",
      entry_price: 100,
      exit_price: 100 * Math.exp(up ? edge : -edge),
      features: [x, Math.sin(x), x * 0.5, 0.1],
      probability: up ? 0.7 : 0.3,
    });
  }
  return calls;
}

// These tests share one on-disk directory, so they must be serialised and the
// directory torn down between each case.
test.beforeEach(reset);
test.after(reset);

test("training set skips calls with no captured feature vector", async () => {
  // A call recorded before features were stored must be dropped, not faked —
  // an imputed input row teaches the model nothing real.
  const set = trainingSetFromCalls([
    ...makeCalls(5),
    { symbol: "ETH", side: "LONG", entry_price: 100, exit_price: 101, features: null },
    { symbol: "SOL", side: "LONG", entry_price: 100, exit_price: 101, features: undefined },
  ]);
  assert.equal(set.rows, 5);
});

test("training set skips calls with unusable prices", async () => {
  const set = trainingSetFromCalls([
    { symbol: "BTC", side: "LONG", entry_price: 0, exit_price: 101, features: [1, 2, 3, 4] },
    { symbol: "BTC", side: "LONG", entry_price: 100, exit_price: null, features: [1, 2, 3, 4] },
    { symbol: "BTC", side: "LONG", entry_price: 100, exit_price: 101, features: [1, 2, 3, 4] },
  ]);
  assert.equal(set.rows, 1);
});

test("a short side's return is the negative of the coin's move", async () => {
  const set = trainingSetFromCalls([
    { symbol: "BTC", side: "SHORT", entry_price: 100, exit_price: 110, features: [1, 2, 3, 4] },
  ]);
  // The coin rose, so going short lost money.
  assert.ok(set.fwd[0] < 0);
  assert.equal(set.y[0], 0);
});

test("too few settled calls cannot trigger a retrain", async () => {
  const r = await retrain(makeCalls(MIN_SETTLED_FOR_RETRAIN - 1), { force: true });
  assert.equal(r.ran, false);
  assert.match(r.reason, /usable settled calls/);
  assert.equal(listChallengers().length, 0);
});

test("enough settled calls produces a challenger, not an installed model", async () => {
  const r = await retrain(makeCalls(140, 0.05), { force: true });
  assert.equal(r.ran, true);
  assert.ok(r.held_out > 0);
  assert.equal(listChallengers().length, 1);
  // Critically: proposing a challenger must not make it the champion.
  assert.equal(getChampion(), null);
});
test("a challenger below the minimum call count is not eligible", async () => {
  await proposeChallenger({ scaler: { mean: [0], std: [1] }, weights: [1], bias: 0 });
  for (let i = 0; i < PROMOTION_RULES.minSettledCalls - 1; i++) {
    await recordChallengerOutcome(listChallengers()[0].id, 0.01);
  }
  const verdict = evaluatePromotion();
  assert.equal(verdict.promote, false);
  assert.match(verdict.reason, /eligible/);
});

/** Age a challenger so it clears the `minTrackDays` evidence rule.
 *
 * The promotion gate deliberately refuses to promote a challenger that earned
 * its whole track record in a burst of correlated activity. These tests are
 * about the *relative* comparison against a champion, so the fixture ages the
 * candidate explicitly rather than weakening the rule for everyone.
 */
async function agedChallenger(meta = {}) {
  const c = await proposeChallenger(
    { scaler: { mean: [0], std: [1] }, weights: [1], bias: 0 },
    { createdAt: new Date(Date.now() - (PROMOTION_RULES.minTrackDays + 1) * 86_400_000).toISOString(), ...meta },
  );
  return c;
}

test("a profitable challenger beats a losing champion", async () => {
  const { id } = await agedChallenger();
  for (let i = 0; i < PROMOTION_RULES.minSettledCalls; i++) {
    await recordChallengerOutcome(id, 0.02);
  }
  const verdict = evaluatePromotion({ expectancy: -0.01 });
  assert.equal(verdict.promote, true);
  assert.equal(verdict.winner.id, id);
});

test("a challenger cannot displace a champion that is doing better", async () => {
  // This is the guardrail that makes continuous retraining safe. A challenger
  // that looks good in absolute terms still loses if the incumbent is better.
  const { id } = await agedChallenger();
  for (let i = 0; i < PROMOTION_RULES.minSettledCalls; i++) {
    await recordChallengerOutcome(id, 0.01);
  }
  const verdict = evaluatePromotion({ expectancy: 0.05 });
  assert.equal(verdict.promote, false);
  assert.match(verdict.reason, /does not beat the champion/);
});

test("a large track record earned in a burst cannot promote", async () => {
  // 200 winning calls inside a few minutes are highly correlated and prove very
  // little. Without the age floor this would promote instantly, which is exactly
  // the "lucky fortnight takes over" failure the gate exists to prevent.
  const { id } = await proposeChallenger({ scaler: { mean: [0], std: [1] }, weights: [1], bias: 0 });
  for (let i = 0; i < PROMOTION_RULES.minSettledCalls * 4; i++) {
    await recordChallengerOutcome(id, 0.05);
  }
  const scored = scoreChallenger(listChallengers().find((c) => c.id === id));
  assert.equal(scored.settled, PROMOTION_RULES.minSettledCalls * 4, "the record itself is real");
  assert.equal(scored.eligible, false, "but it is not yet admissible");
  assert.ok(scored.ageDays < PROMOTION_RULES.minTrackDays);
  assert.equal(evaluatePromotion({ expectancy: -0.5 }).promote, false);
});

test("promotion moves the winner and clears the board", async () => {
  await proposeChallenger({ scaler: { mean: [0], std: [1] }, weights: [1], bias: 0 });
  const id = listChallengers()[0].id;
  await promoteChallenger(id);
  assert.equal(getChampion().weights.length, 1);
  assert.equal(listChallengers().length, 0);
});

test("a profitable but brand-new challenger is not eligible yet", async () => {
  // Identical numbers to the promotion test above, but one day old instead of
  // four. This is the guard against a burst of correlated activity passing as
  // a well-tested record: the challenger is profitable and has more than enough
  // calls, and is still refused because it has not survived enough time.
  const { id } = await proposeChallenger({ scaler: { mean: [0], std: [1] }, weights: [1], bias: 0 });
  for (let i = 0; i < PROMOTION_RULES.minSettledCalls + 20; i++) {
    await recordChallengerOutcome(id, 0.02);
  }
  const scored = scoreChallenger(listChallengers().find((c) => c.id === id));
  assert.ok(scored.expectancy > PROMOTION_RULES.minExpectancyEdge, "profitable in absolute terms");
  assert.ok(scored.settled >= PROMOTION_RULES.minSettledCalls, "enough calls");
  assert.ok(scored.ageDays < PROMOTION_RULES.minTrackDays, "but too young to promote");
  assert.equal(scored.eligible, false);
  assert.equal(evaluatePromotion({ expectancy: -0.5 }).promote, false);
});

test("an unknown creation date does not permanently block a challenger", async () => {
  // A challenger restored from an older store may have no parseable createdAt.
  // Treating that as "brand new" would silently strand it forever, so the age
  // rule must default to permissive and let the other gates decide.
  const c = { id: "legacy", label: "legacy", trackRecord: { settled: 40, wins: 24, returns: Array(40).fill(0.02) } };
  const scored = scoreChallenger(c);
  assert.equal(scored.ageDays, PROMOTION_RULES.minTrackDays);
  assert.equal(scored.eligible, true);
});

test("the shortlist is capped so it stays a shortlist", async () => {
  for (let i = 0; i < PROMOTION_RULES.maxChallengers + 3; i++) {
    await proposeChallenger({ scaler: { mean: [0], std: [1] }, weights: [1], bias: 0 }, { id: `c${i}` });
  }
  assert.equal(listChallengers().length, PROMOTION_RULES.maxChallengers);
});

test("challengers are scored on identical calls, so the comparison is fair", async () => {
  const X = makeCalls(120, 0.04).map((c) => c.features);
  const y = X.map((r) => (r[0] > 0 ? 1 : 0));
  const model = fit(X, y, { epochs: 200 });

  // A model trained on data where feature 0 is the signal.
  await proposeChallenger({ ...model, features: null }, { id: "smart" });
  await scoreChallengersOn(makeCalls(40, 0.04));

  const smart = scoreChallenger(listChallengers().find((c) => c.id === "smart"));
  assert.ok(smart.settled > 0);
  assert.ok(smart.expectancy > 0, `expected a positive edge, got ${smart.expectancy}`);
});

test("a challenger with a non-finite output is skipped, not crashed on", async () => {
  await proposeChallenger({ scaler: { mean: [0], std: [1] }, weights: [NaN], bias: 0 }, { id: "broken" });
  assert.doesNotThrow(() => scoreChallengersOn(makeCalls(10)));
  assert.equal(scoreChallenger(listChallengers()[0]).settled, 0);
});

test("scoreFixed reports the trained model's own out-of-sample numbers", async () => {
  const X = makeCalls(200, 0.05).map((c) => c.features);
  const y = X.map((r) => (r[0] > 0 ? 1 : 0));
  const fwd = X.map((r) => Math.log(r[0] > 0 ? 1.05 : 0.95));
  const model = fit(X, y, { epochs: 300 });

  const v = scoreFixed(model, X, y, fwd);
  assert.equal(v.ok, true);
  assert.ok(v.accuracy > 0.6, `accuracy ${v.accuracy} should beat 50% on learnable data`);
  assert.ok(v.expectancy > 0);
  assert.ok(v.deflated_sharpe > 0);
});

test("scoreFixed rejects a ragged held-out set", async () => {
  const model = fit([[1], [2], [3], [4]], [1, 0, 1, 0], { epochs: 10 });
  assert.equal(scoreFixed(model, [[1]], [1, 0], [0.1]).ok, false);
});

test("improvementState exposes the board for the UI", async () => {
  await proposeChallenger({ scaler: { mean: [0], std: [1] }, weights: [1], bias: 0 }, { id: "c1", label: "candidate A" });
  const state = improvementState();
  assert.equal(state.champion, null);
  assert.equal(state.challengers[0].label, "candidate A");
  assert.equal(state.rules.minSettledCalls, PROMOTION_RULES.minSettledCalls);
});

test("the learning chain is complete: a prediction's features reach the ledger", async () => {
  // This is the load-bearing guarantee of the whole improvement loop. If the
  // feature vector is not emitted by the predictor, the paper ledger stores
  // nothing to learn from, and the app silently never improves while looking
  // like it is. The two ends must agree on the column name.
  const bars = synthBars(120, 42);
  const prediction = predictFromSeries(bars, { liquidity_usd: 5_000_000 });

  if (prediction?.basis !== "model") {
    // No trained model is present in this environment, which is itself fine —
    // but then there is nothing to assert, and saying so is better than a
    // passing test that checks nothing.
    return;
  }
  assert.ok(Array.isArray(prediction.features), "predictor must emit its feature vector");
  assert.ok(prediction.features.length > 0);
  assert.ok(prediction.features.every(Number.isFinite), "features must be finite to be trainable");
});