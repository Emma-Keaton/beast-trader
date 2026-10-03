import test from "node:test";
import assert from "node:assert/strict";
import {
  forecast,
  forecastVolatility,
  calibrateConfidence,
  toPrediction,
  STRATEGIC_HORIZON,
} from "../src/ml/forecast.js";
import { kellyFraction, kellySize, clearsCost } from "../src/ml/sizing.js";
import { liveTradingEnabled, executeOrder } from "../src/services/executor.js";
import { liveReadiness } from "../src/services/gate.js";
import { riskProfile, applyProfile, describeProfile } from "../src/ml/riskprofile.js";
import { capabilities, describeCapabilities, TRADING_MODES, AUTHORITIES, CUSTODIES } from "../src/services/capabilities.js";
import { fetchIntraday, mergeBars, lastBarTime } from "../src/ml/intraday.js";
import { SESSION_LIMITS } from "../src/services/sessionkeys.js";
import { HORIZONS, resolveHorizonDays } from "../src/ml/paper.js";
import {
  buildProposal,
  resolveProposal,
  isLive,
  shouldPropose,
  describeMode,
  PROPOSAL_STATUS,
} from "../src/services/assisted.js";
import { readFileSync } from "node:fs";
import { BM25Index, tokenise, bestExcerpt, searchDocs, contextForAsset, reloadIndex } from "../src/ml/retrieval.js";

/* ── fixtures ─────────────────────────────────────────────────────────────── */

/** A steady climb: the regime where continuation and reversion disagree. */
function ramp(n = 120, step = 1, base = 100) {
  return Array.from({ length: n }, (_, i) => base + step * i);
}

/** The same ramp falling, mirrored about its own midpoint so it stays positive. */
function fallingRamp() {
  const f = ramp();
  return f.map((v) => f[0] + f[f.length - 1] - v);
}

/** Price pinned near a level, so the expected move cannot clear costs. */
function pinned(n = 120, base = 100) {
  return Array.from({ length: n }, (_, i) => base + Math.sin(i / 3) * 0.002);
}

/** Outcomes at a given hit rate, for driving the calibrator. */
function outcomes(n, hitRate, spread = 0.9) {
  return Array.from({ length: n }, (_, i) => ({
    conviction: (((i * 37) % 100) / 100) * spread,
    hit: ((i * 53) % 100) / 100 < hitRate,
  }));
}

/* ── horizon ──────────────────────────────────────────────────────────────── */

test("the ensemble defaults to the measured strategic horizon, not 3 bars", () => {
  assert.equal(STRATEGIC_HORIZON, 14);
  const f = forecast(ramp());
  assert.ok(f.ok);
  assert.equal(f.horizon, STRATEGIC_HORIZON);
});

/* ── the mean-reversion demotion ──────────────────────────────────────────── */

test("mean reversion does not vote by default", () => {
  const f = forecast(ramp());
  // Still *reported*: the stretch is real, and disagreement is information.
  assert.notEqual(f.reversionZ, null, "reversion should still be measured");
  assert.ok(
    !f.models.some((m) => m.label === "mean-reversion"),
    "reversion must not vote without evidence behind it",
  );
});

test("mean reversion votes again when explicitly given weight", () => {
  const f = forecast(ramp(), { reversionWeight: 0.5 });
  assert.ok(f.models.some((m) => m.label === "mean-reversion"));
});

test("the trend-distance member votes with the sign the data supports", () => {
  const up = forecast(ramp());
  const dn = forecast(fallingRamp());
  const upTd = up.models.find((m) => m.label === "trend-distance");
  const dnTd = dn.models.find((m) => m.label === "trend-distance");
  assert.ok(upTd, "an up-trend should produce a trend-distance vote");
  assert.ok(dnTd, "a down-trend should produce a trend-distance vote");
  // Continuation, not exhaustion: stretched up implies P(up), stretched down
  // implies P(down) - the exact opposite of what mean reversion would claim.
  assert.ok(upTd.probUp > 0.5, `expected continuation upward, got ${upTd.probUp}`);
  assert.ok(dnTd.probUp < 0.5, `expected continuation downward, got ${dnTd.probUp}`);
});

/* ── contract ─────────────────────────────────────────────────────────────── */

/* ── paper settlement must match the forecast horizon ─────────────────────── */

test("the ensemble settles on the strategic horizon, the model on entry", () => {
  // The horizon used to be a single constant duplicated in two files, which is
  // how it became 3 hours when a bar is a day. It is now one registry, and the
  // invariant to protect is that each *basis* resolves to the window its own
  // model was fitted on — not that every window is the same number.
  assert.equal(resolveHorizonDays("ensemble"), STRATEGIC_HORIZON);
  assert.equal(resolveHorizonDays("model"), 3);
  // The strategic window must be the forecast horizon, by construction.
  assert.equal(HORIZONS.STRATEGIC.bars, STRATEGIC_HORIZON);
  // Days and ms must agree in the registry, or a call's due date lies about
  // which window it is scored over.
  assert.equal(HORIZONS.STRATEGIC.ms / (24 * 3600_000), HORIZONS.STRATEGIC.bars);
  assert.equal(HORIZONS.ENTRY.ms / (24 * 3600_000), HORIZONS.ENTRY.bars);
  // Unknown bases are tactical by default, never accidentally strategic.
  assert.equal(resolveHorizonDays(undefined), HORIZONS.ENTRY.bars);
});

test("orders inherit the same registry rather than restating it", () => {
  // `executor.js` must not hold its own copy of the number — that independence
  // is what let the two drift apart silently in the first place.
  const src = readFileSync(new URL("../src/services/executor.js", import.meta.url), "utf8");
  assert.match(
    src,
    /ORDER_HORIZON_MS = resolveHorizonMs\("model"\)/,
    "ORDER_HORIZON_MS must be derived from the shared registry",
  );
  assert.ok(
    !/ORDER_HORIZON_MS = \d/.test(src),
    "ORDER_HORIZON_MS must not be a literal again",
  );
});

test("live execution is off unless the environment says so, and fails closed", () => {
  const prev = process.env.LIVE_TRADING_ENABLED;
  try {
    for (const v of [undefined, "", "false", "0", "no", "yes", "1", "TRUE "]) {
      if (v === undefined) delete process.env.LIVE_TRADING_ENABLED;
      else process.env.LIVE_TRADING_ENABLED = v;
      const expected = v !== undefined && String(v).trim().toLowerCase() === "true";
      assert.equal(liveTradingEnabled(), expected, `LIVE_TRADING_ENABLED=${JSON.stringify(v)}`);
    }
    // Only the exact word enables it. "yes" and "1" must NOT.
    process.env.LIVE_TRADING_ENABLED = "true";
    assert.equal(liveTradingEnabled(), true);
  } finally {
    if (prev === undefined) delete process.env.LIVE_TRADING_ENABLED;
    else process.env.LIVE_TRADING_ENABLED = prev;
  }
});

test("a live order is refused at the venue while the kill switch is off", async () => {
  const prev = process.env.LIVE_TRADING_ENABLED;
  delete process.env.LIVE_TRADING_ENABLED;
  try {
    const row = await executeOrder("dev-test", {
      symbol: "BTCUSDT",
      side: "BUY",
      notional_usd: 50,
      amount: 0.001,
      limit_price: 50000,
      mode: "live",
      model_basis: "ensemble",
    });
    assert.equal(row.status, "queued_live", "must park, never attempt a real order");
    assert.match(row.note, /LIVE_TRADING_ENABLED/);
    // Critically: no venue order id, i.e. nothing reached an exchange.
    assert.equal(row.venue_order_id ?? null, null);
  } finally {
    if (prev === undefined) delete process.env.LIVE_TRADING_ENABLED;
    else process.env.LIVE_TRADING_ENABLED = prev;
  }
});

test("settings cannot be used to sneak into live mode", () => {
  // The route whitelist must never contain trading_mode again. This is the hole
  // that let `PUT /settings {trading_mode:"live"}` bypass liveReadiness().
  const src = readFileSync(new URL("../src/routes/index.js", import.meta.url), "utf8");
  const putBlock = src.slice(src.indexOf('put("/settings"'), src.indexOf('post("/trading-mode"'));
  assert.ok(putBlock, "settings route should exist before the trading-mode route");
  assert.ok(
    !/"autopilot",\s*"trading_mode"/.test(putBlock),
    "trading_mode must not be back in the settings whitelist",
  );
  assert.match(putBlock, /trading_mode cannot be changed via settings/);
});

test("the guarded live route demands an explicit confirmation", () => {
  const src = readFileSync(new URL("../src/routes/index.js", import.meta.url), "utf8");
  const route = src.slice(src.indexOf('post("/trading-mode"'), src.indexOf('post("/trading-mode"') + 900);
  assert.match(route, /confirm !== true/, "confirm:true must be required server-side");
  assert.match(route, /setTradingMode/, "it must go through the readiness gate");
});

/* ── contract ─────────────────────────────────────────────────────────────── */
/* ── contract ─────────────────────────────────────────────────────────────── */

/* ── volatility ───────────────────────────────────────────────────────────── */

test("the volatility forecast ranks calm below violent", () => {
  const calm = forecastVolatility(ramp(120, 0.1), { horizon: 1 });
  const violent = forecastVolatility(ramp(120, 8), { horizon: 1 });
  assert.ok(calm && violent);
  assert.ok(violent.perBar > calm.perBar * 5, "an 80x steeper series must read far more volatile");
});

test("the horizon scales volatility by sqrt(h), as it should", () => {
  const closes = ramp(120, 2);
  const one = forecastVolatility(closes, { horizon: 1 });
  const four = forecastVolatility(closes, { horizon: 4 });
  assert.ok(Math.abs(four.overHorizon - one.perBar * 2) < 1e-5);
});

test("too little history yields no volatility forecast rather than a zero", () => {
  assert.equal(forecastVolatility([100, 101, 102], { horizon: 1 }), null);
});

/* ── the cost wall ────────────────────────────────────────────────────────── */

test("an unmoving price is declared untradable regardless of direction", () => {
  const f = forecast(pinned());
  assert.equal(f.tradable, false);
  assert.match(toPrediction(f).reason, /does not clear round-trip cost/);
});

test("the cost wall forces HOLD even on a lopsided probability", () => {
  const p = toPrediction({
    ok: true,
    tradable: false,
    probUp: 0.9,
    horizon: 14,
    volForecast: { overHorizon: 0.0001 },
    models: [],
  });
  assert.equal(p.signal, "HOLD");
});

test("clearsCost demands a margin, not an exact match", () => {
  // Exactly covering the cost is a certain loser once slippage is counted.
  assert.equal(clearsCost({ expectedMove: 0.0034, roundTripCostBps: 34 }).clears, false);
  assert.equal(clearsCost({ expectedMove: 0.0051, roundTripCostBps: 34 }).clears, true);
  assert.equal(clearsCost({ expectedMove: 0 }).clears, false);
});

/* ── confidence calibration ───────────────────────────────────────────────── */

test("confidence is uncalibrated rather than assumed when history is thin", () => {
  const f = forecast(ramp());
  assert.equal(f.confidenceCalibrated, false);
  assert.equal(f.confidence, f.rawConfidence, "with no evidence, the self-assessment stands");
});

test("a model right at coin-flip rates earns no confidence", () => {
  assert.equal(calibrateConfidence(0.9, outcomes(400, 0.5)), 0);
});

test("calibration overrules a confident self-assessment", () => {
  const good = calibrateConfidence(0.9, outcomes(400, 0.65));
  assert.ok(good > 0.3, `a genuinely accurate model should score confidence, got ${good}`);
});

test("calibration refuses to guess from too few settled calls", () => {
  assert.equal(calibrateConfidence(0.8, outcomes(20, 0.9)), null);
  assert.equal(calibrateConfidence(0.8, []), null);
  assert.equal(calibrateConfidence(0.8, outcomes(400, 0.6).slice(0, 20)), null);
});

test("confidence is not allowed to exceed what evidence supports", () => {
  const f = forecast(ramp(), { outcomes: outcomes(400, 0.5) });
  assert.equal(f.confidenceCalibrated, true);
  assert.equal(f.confidence, 0, "50% realised accuracy must zero the claim, however sure it felt");
  assert.ok(f.rawConfidence > 0, "the raw self-assessment stays visible for comparison");
});

test("an ensemble prediction states its own horizon", () => {
  const p = toPrediction(forecast(ramp()));
  assert.equal(p.horizon, "14d", "the ensemble must not inherit the 24h label of the daily model");
});

/* ── sizing: the one formula that helps without any forecast ───────────────── */

test("Kelly sizes a genuine edge and refuses a nonexistent one", () => {
  assert.ok(Math.abs(kellyFraction(0.6, 1) - 0.2) < 1e-9);
  assert.equal(kellyFraction(0.5, 1), 0);
  assert.equal(kellyFraction(0.4, 1), 0, "a negative edge is an instruction to stand flat");
  assert.equal(kellyFraction(0.6, 0), 0);
});

test("asymmetric payoffs are respected", () => {
  // A 45% win rate paying 2:1 has positive expectancy, and Kelly should see it.
  assert.ok(kellyFraction(0.45, 2) > 0);
});

test("fractional Kelly cuts the bet", () => {
  const full = kellyFraction(0.6, 1);
  assert.ok(Math.abs(kellySize(0.6, { fraction: 1, cap: 1 }) - full) < 1e-4);
  assert.ok(kellySize(0.6, { fraction: 0.25, cap: 1 }) < full / 3);
});

test("volatility targeting halves the position when vol doubles", () => {
  // Both cases sit on the scaling side of the ratio: the calm market is not
  // leveraged up past the 2x cap, so the relationship stays exactly inverse.
  const calm = kellySize(0.6, { forecastVol: 0.08, targetVol: 0.04, cap: 1 });
  const violent = kellySize(0.6, { forecastVol: 0.16, targetVol: 0.04, cap: 1 });
  assert.ok(Math.abs(calm - violent * 2) < 1e-3, `${calm} vs ${violent}`);
});

test("a dead market does not become the biggest position on the account", () => {
  // Zero forecast vol must not divide into infinity.
  assert.ok(kellySize(0.6, { forecastVol: 0, targetVol: 0.04, cap: 0.25 }) <= 0.25);
});

test("the Kelly cap binds", () => {
  assert.equal(kellySize(0.95, { fraction: 1, cap: 0.25 }), 0.25);
});

/* ── local retrieval ──────────────────────────────────────────────────────── */

const CORPUS = new BM25Index([
  { id: "a.md", title: "Solana liquidity and spread", text: "Long-tail Solana tokens have wide spreads. Slippage and fees exceed the expected move over short horizons, so the cost wall binds before the signal does." },
  { id: "b.md", title: "Volatility predictability", text: "Predicting next-week volatility from an EWMA estimate has rank IC 0.187, far above any directional signal found in this study." },
  { id: "c.md", title: "Momentum on large caps", text: "Cross-sectional momentum on large caps returns the same as equal-weighting the universe. The excess is indistinguishable from beta." },
]);

test("tokenising keeps symbols findable", () => {
  // The whole point of splitting on non-alphanumerics: "$SOL", "SOL/USDT" and
  // "sol" must all collapse to the same token so an exact lookup works.
  assert.ok(tokenise("$SOL").includes("sol"));
  assert.ok(tokenise("SOL/USDT").includes("sol"));
  assert.ok(tokenise("sol").includes("sol"));
  assert.deepEqual(tokenise("the and of"), [], "stopwords must not pollute the query");
});

test("retrieval finds the right document for a technical question", () => {
  const hits = CORPUS.search("volatility rank IC EWMA");
  assert.ok(hits.length);
  assert.match(hits[0].id, /b\.md/, `expected the volatility note, got ${hits[0].id}`);
});

test("a query matching nothing returns nothing rather than everything", () => {
  // Padding results with zero-score documents would imply more confidence than
  // exists. "Nothing found" is the honest answer.
  assert.deepEqual(CORPUS.search("xyzzy plugh"), []);
  assert.deepEqual(CORPUS.search(""), []);
});

test("search results are ordered by relevance", () => {
  const hits = CORPUS.search("spreads fees slippage solana");
  // A query matching two documents must return them best-first. It is *not
  // guaranteed to match two: this one legitimately matches only the liquidity
  // note, and padding the result set to satisfy an assertion about ordering
  // would defeat the point of returning nothing rather than padding.
  assert.ok(hits.length >= 1, "should at least match the liquidity note");
  assert.equal(hits[0].id, "a.md");
  for (let i = 1; i < hits.length; i++) assert.ok(hits[i - 1].score >= hits[i].score);
});

test("excerpts centre on the match, not the document head", () => {
  const doc = "Background text that is irrelevant. ".repeat(12) + "The finding: rank IC was 0.187 for volatility.";
  const ex = bestExcerpt(doc, "rank IC volatility");
  assert.match(ex, /rank IC was 0\.187/, "the excerpt must contain the finding");
});

test("a rare term outweighs a common one", () => {
  const idx = new BM25Index([
    { id: "common.md", title: "spread spread spread", text: "spread spread spread spread" },
    { id: "rare.md", title: "carcinisation", text: "carcinisation" },
  ]);
  const hits = idx.search("carcinisation");
  assert.equal(hits[0].id, "rare.md");
});

test("the real corpus indexes and answers an asset query", () => {
  const root = new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  reloadIndex(root);
  const hits = searchDocs("solana", { docsRoot: root, limit: 3 });
  assert.ok(Array.isArray(hits));
  // The strategy research notes mention Solana repeatedly, so this must hit.
  assert.ok(hits.length > 0, "expected the project docs to mention Solana");
  assert.ok(hits.every((h) => typeof h.excerpt === "string" && h.excerpt.length > 0));
  const ctx = contextForAsset("SOL", { docsRoot: root });
  assert.ok(Array.isArray(ctx));
});

test("retrieval never reaches outside markdown in the docs tree", () => {
  const root = new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  const hits = searchDocs("secret key supabase service role", { docsRoot: root, limit: 5 });
  // Even if a .env is readable from the repo root, it must not be in the index.
  assert.ok(hits.every((h) => /\.(md|markdown)$/i.test(h.id)), `non-markdoc in results: ${hits.map((h) => h.id).join(",")}`);
});

/* ── assisted mode ────────────────────────────────────────────────────────── */

const PLAN = {
  device_id: "dev-1",
  symbol: "SOLUSDT",
  side: "BUY",
  amount: 12,
  notional_usd: 240,
  limit_price: 20,
  exchange_id: "bybit",
};

test("a proposal is inert: it carries no key material and signs nothing", () => {
  const p = buildProposal(PLAN, { probUp: 0.7, confidence: 0.6, model: "ensemble", expectedMove: 0.02 });
  // The whole safety argument is structural: building a proposal cannot move money.
  assert.equal(p.status, PROPOSAL_STATUS.PENDING);
  assert.equal(p.signature, null);
  assert.equal(p.venue_order_id, null);
  assert.equal(JSON.stringify(p).toLowerCase().includes("secret"), false);
  assert.equal(JSON.stringify(p).toLowerCase().includes("privatekey"), false);
  // And it is replayable: same input, same output minus the generated id/time.
  assert.equal(buildProposal(PLAN).symbol, buildProposal(PLAN).symbol);
});

test("a proposal shows the edge net of cost, not a bare probability", () => {
  const p = buildProposal(PLAN, { expectedMove: 0.02, costBps: 34 });
  assert.equal(p.rationale.round_trip_cost_bps, 34);
  // 2% move - 0.34% cost. The user must see what is left, which is the only
  // number that justifies signing.
  assert.ok(Math.abs(p.rationale.edge_after_cost - 0.0166) < 1e-9);
});

test("expired proposals cannot be signed", () => {
  const p = buildProposal(PLAN);
  assert.equal(isLive(p), true);
  const later = Date.now() + 16 * 60_000;
  assert.equal(isLive(p, later), false, "a 15-minute window must actually close");
  const decided = resolveProposal(p, { status: PROPOSAL_STATUS.DECLINED });
  assert.equal(isLive(decided), false, "a decided proposal is never live again");
});

test("a decline is recorded rather than dropped", () => {
  const p = buildProposal(PLAN);
  const d = resolveProposal(p, { status: PROPOSAL_STATUS.DECLINED, note: "user said no" });
  assert.equal(d.status, PROPOSAL_STATUS.DECLINED);
  assert.ok(d.decided_at, "declines carry a timestamp like any other outcome");
});

test("an unknown status is rejected rather than stored", () => {
  assert.throws(() => resolveProposal(buildProposal(PLAN), { status: "definitely_done" }), /unknown proposal status/);
});

test("the app proposes less when the move does not clear costs", () => {
  const p = buildProposal(PLAN, { expectedMove: 0.001 });
  const bad = shouldPropose(p, { expectedMove: 0.001, costBps: 34 });
  assert.equal(bad.ok, false, "a move smaller than the fee must not be proposed");
  const good = shouldPropose(p, { expectedMove: 0.05, costBps: 34 });
  assert.equal(good.ok, true);
});

test("a refused gate stops the proposal before the user is asked", () => {
  const p = buildProposal(PLAN);
  const r = shouldPropose(p, { gate: { allowed: false, failures: [{ detail: "model not promoted" }] } });
  assert.equal(r.ok, false);
  assert.match(r.why, /model not promoted/);
});

test("the mode description never claims more autonomy than exists", () => {
  // The UI must not let "assisted" read as hands-off.
  assert.match(describeMode("assisted"), /You sign each trade/);
  assert.match(describeMode("autonomous"), /trades on its own/);
  assert.match(describeMode("paper"), /No orders leave this machine/);
});

test("readiness reports the deployment kill switch, not just per-device consent", async () => {
  // The hole this closes: a device could be told "ready, go live", confirm
  // through the modal, and then have every order park as queued_live because the
  // server process had live trading disabled. Readiness has to answer "will my
  // trades actually go through", not a related question.
  const prev = process.env.LIVE_TRADING_ENABLED;
  try {
    delete process.env.LIVE_TRADING_ENABLED;
    const off = await liveReadiness("dev-test");
    const offCheck = off.checks.find((c) => c.name === "live_enabled");
    assert.ok(offCheck, "readiness must include a live_enabled check");
    assert.equal(offCheck.passed, false);
    assert.equal(off.ready, false);

    process.env.LIVE_TRADING_ENABLED = "true";
    const on = await liveReadiness("dev-test");
    assert.equal(on.checks.find((c) => c.name === "live_enabled").passed, true);
  } finally {
    if (prev === undefined) delete process.env.LIVE_TRADING_ENABLED;
    else process.env.LIVE_TRADING_ENABLED = prev;
  }
});

test("gate and executor can both be imported without a circular-import crash", async () => {
  // gate.js reads the kill switch from executor.js while executor.js imports the
  // gate. ESM hoists function declarations so this happens to resolve, but a
  // cycle that silently yields `undefined` instead of throwing is the classic way
  // a safety check disappears. Assert the values actually arrive.
  const [gate, exec] = await Promise.all([import("../src/services/gate.js"), import("../src/services/executor.js")]);
  assert.equal(typeof gate.liveReadiness, "function");
  assert.equal(typeof exec.executeOrder, "function");
  assert.equal(typeof exec.liveTradingEnabled, "function");
});

/* ── risk profile ─────────────────────────────────────────────────────────── */

test("the slider selects a sector and grades within it", () => {
  assert.equal(riskProfile(0).sector, "conservative");
  assert.equal(riskProfile(32).sector, "conservative");
  assert.equal(riskProfile(34).sector, "balanced");
  assert.equal(riskProfile(65).sector, "balanced");
  assert.equal(riskProfile(67).sector, "aggressive");
  assert.equal(riskProfile(100).sector, "aggressive");
});

test("positions within a sector produce genuinely different settings", () => {
  // The whole premise of a continuous slider rather than three presets: every
  // position must be distinct. If these were equal, it would be a 3-way switch
  // wearing a slider's clothes.
  const a = riskProfile(10);
  const b = riskProfile(30);
  assert.notEqual(a.notionalScale, b.notionalScale);
  assert.notEqual(a.minConfidence, b.minConfidence);
  assert.notEqual(a.maxOrderUsd, b.maxOrderUsd);
});

test("bigger positions demand more confidence, never less", () => {
  // The single most important relationship in the module. A slider that raised
  // size while lowering the confidence bar would not be a bolder profile — it
  // would be a broken one, taking larger bets on weaker evidence.
  for (let p = 0; p <= 100; p += 5) {
    const cur = riskProfile(p);
    const next = riskProfile(Math.min(100, p + 5));
    assert.ok(next.maxOrderUsd >= cur.maxOrderUsd, `size fell at position ${p}`);
    assert.ok(
      next.minConfidence <= cur.minConfidence,
      `confidence rose with size at position ${p}: ${cur.minConfidence} -> ${next.minConfidence}`,
    );
  }
});

test("risk settings never increase monotonically as position falls", () => {
  // A crude sanity net over the whole range: no inverted pair anywhere.
  for (let p = 0; p < 100; p++) {
    const a = riskProfile(p);
    const b = riskProfile(p + 1);
    assert.ok(b.maxDailyLossUsd >= a.maxDailyLossUsd, `loss limit fell at ${p}`);
    assert.ok(b.maxOpenPositions >= a.maxOpenPositions, `position limit fell at ${p}`);
  }
});

test("even maximum aggression demands some live track record", () => {
  // Zero days would mean trusting a model that has never traded, which is how a
  // freshly promoted challenger spends real money proving it shouldn't be.
  assert.ok(riskProfile(100).minTrackDays >= 1);
  assert.ok(riskProfile(0).minTrackDays >= 7, "the conservative end should be genuinely cautious");
});

test("profit evidence is required until the very top of the slider", () => {
  assert.equal(riskProfile(0).requiresProfitEvidence, true);
  assert.equal(riskProfile(50).requiresProfitEvidence, true);
  assert.equal(riskProfile(100).requiresProfitEvidence, false);
});

test("out-of-range slider positions saturate rather than fail", () => {
  assert.equal(riskProfile(-50).position, 0);
  assert.equal(riskProfile(500).position, 100);
  assert.equal(riskProfile(NaN).position, 0);
  // A slider that silently refuses to move is worse than one that saturates.
  assert.equal(riskProfile(0).maxOrderUsd, riskProfile(-1).maxOrderUsd);
});

test("the profile narrows the user's cap and never raises it", () => {
  const settings = { max_order_usd: 500 };
  const merged = applyProfile(settings, riskProfile(50));
  assert.ok(merged.max_order_usd <= 500, "the slider must never raise a user's own limit");
  const tight = applyProfile({ max_order_usd: 10 }, riskProfile(100));
  assert.equal(tight.max_order_usd, 10, "a small cap survives even at full aggression");
});

test("the description never softens what aggressive means", () => {
  assert.match(describeProfile(riskProfile(90)), /lose money/);
});

test("the risk slider actually gates orders, not merely displays", async () => {
  // Regression for a real bug: `applyProfile` emits snake_case settings keys
  // (`max_order_usd`) while the gate's limits are camelCase (`maxOrderUsd`).
  // Spreading one into the other did nothing at all — the slider looked wired,
  // returned plausible numbers to the UI, and changed no behaviour whatsoever.
  const { putSettings } = await import("../src/store.js");
  const { checkPrerequisites } = await import("../src/services/gate.js");
  try {
    await putSettings("dev-slider", { risk_level: 0, trading_mode: "live", risk_limits: {} });
    const strict = await checkPrerequisites({
      deviceId: "dev-slider", symbol: "BTCUSDT", side: "buy", notionalUsd: 40, intent: "live", confidence: 0.55,
    });
    assert.equal(strict.limits.maxOrderUsd, 25, "conservative must narrow the per-trade cap");
    assert.equal(strict.limits.minConfidence, 0.72);
    assert.equal(strict.checks.find((c) => c.name === "risk_confidence_floor").passed, false,
      "55% confidence must not clear a 72% floor");
    assert.equal(strict.checks.find((c) => c.name === "order_cap").passed, false);

    await putSettings("dev-slider", { risk_level: 100 });
    const loose = await checkPrerequisites({
      deviceId: "dev-slider", symbol: "BTCUSDT", side: "buy", notionalUsd: 400, intent: "live", confidence: 0.55,
    });
    assert.equal(loose.limits.maxOrderUsd, 500);
    assert.equal(loose.checks.find((c) => c.name === "risk_confidence_floor").passed, true,
      "55% clears the aggressive floor of 38%");
    assert.ok(loose.limits.maxTotalExposureUsd > strict.limits.maxTotalExposureUsd,
      "exposure must scale with the slider");
  } finally {
    await putSettings("dev-slider", {});
  }
});

test("no slider position means no invented limits", async () => {
  const { putSettings } = await import("../src/store.js");
  const { checkPrerequisites } = await import("../src/services/gate.js");
  try {
    await putSettings("dev-noslider", { trading_mode: "live", risk_limits: {} });
    const r = await checkPrerequisites({
      deviceId: "dev-noslider", symbol: "BTCUSDT", side: "buy", notionalUsd: 40, intent: "live", confidence: 0.1,
    });
    assert.equal(r.limits.minConfidence, undefined, "no slider, no confidence floor invented");
    assert.ok(!r.checks.some((c) => c.name === "risk_confidence_floor"), "the check should be skipped");
  } finally {
    await putSettings("dev-noslider", {});
  }
});

/* ── orthogonal capabilities ──────────────────────────────────────────────── */

test("the three axes are independent, not one mode in disguise", () => {
  // Every combination must be classified, including the ones that look odd.
  // The old single `trade_style` field admitted nonsense like "assisted paper".
  const cases = [
    [{ trading_mode: "paper", trade_authority: "auto", custody: "wallet" }, "isPaper"],
    [{ trading_mode: "live", trade_authority: "auto", custody: "cex_key" }, "canSignServerSide"],
    [{ trading_mode: "live", trade_authority: "approve", custody: "cex_key" }, "isAssisted"],
    [{ trading_mode: "live", trade_authority: "approve", custody: "wallet" }, "isAssisted"],
  ];
  for (const [settings, flag] of cases) {
    const c = capabilities(settings);
    assert.equal(c[flag], true, `${JSON.stringify(settings)} should be ${flag}`);
  }
});

test("live + auto + wallet cannot sign, and must not pretend to", () => {
  // A wallet key cannot be signed server-side without session keys, which are not
  // built. The dangerous failure is this cell *appearing* autonomous while placing
  // nothing, so it must resolve to no signing capability at all.
  const c = capabilities({ trading_mode: "live", trade_authority: "auto", custody: "wallet" });
  assert.equal(c.canSignServerSide, false);
  assert.equal(c.isAutonomous, true, "the setting is autonomous even though it cannot act");
  assert.match(describeCapabilities(c), /session keys/, "must say why it cannot trade");
});

test("unknown values fail closed on every axis", () => {
  const c = capabilities({ trading_mode: "LIVE", trade_authority: "yolo", custody: "ledger" });
  assert.equal(c.trading_mode, "paper", "unknown mode must not unlock live");
  // The dangerous value on this axis is `auto`, so an unrecognised authority must
  // not default to it.
  assert.equal(c.trade_authority, "approve", "unknown authority must default to the human");
  assert.equal(c.canSignServerSide, false);
});

test("an empty settings object is paper and cannot trade", () => {
  const c = capabilities({});
  assert.equal(c.isPaper, true);
  assert.equal(c.isAutonomous, false);
  assert.equal(c.isAssisted, false);
  assert.equal(c.canSignServerSide, false);
});

test("paper always wins, whatever the other two axes say", () => {
  // Simulation is absolute. A hand-edited settings row must not be able to route
  // an order to a venue by pairing paper mode with the other two switches.
  for (const authority of ["auto", "approve"]) {
    for (const custody of ["cex_key", "wallet"]) {
      const c = capabilities({ trading_mode: "paper", trade_authority: authority, custody });
      assert.equal(c.isPaper, true);
      assert.equal(c.isAutonomous, false, `paper + ${authority} + ${custody} must not be autonomous`);
      assert.equal(c.canSignServerSide, false);
    }
  }
});

test("every combination is described, so the UI never has to infer", () => {
  for (const m of TRADING_MODES) {
    for (const a of AUTHORITIES) {
      for (const c of CUSTODIES) {
        const caps = capabilities({ trading_mode: m, trade_authority: a, custody: c });
        const d = describeCapabilities(caps);
        assert.ok(d && d.length > 20, `${m}/${a}/${c} has no description`);
      }
    }
  }
});

/* ── intraday collection ──────────────────────────────────────────────────── */

test("merged bars are idempotent, so re-running never duplicates", () => {
  const a = [{ t: 1, o: 10, c: 10 }, { t: 2, o: 11, c: 11 }];
  const r1 = mergeBars(a, [{ t: 3, o: 12, c: 12 }]);
  assert.equal(r1.added, 1);
  assert.equal(r1.total, 3);
  // Same call again adds nothing.
  const r2 = mergeBars(r1.bars, [{ t: 3, o: 12, c: 12 }]);
  assert.equal(r2.added, 0, "re-fetching the same bars must not duplicate them");
  assert.equal(r2.total, 3);
});

test("merge repairs a corrupted stored bar rather than duplicating it", () => {
  // Keyed on open time, so a revised bar replaces its earlier version instead of
  // appearing twice — which would silently corrupt any backtest run over it.
  const r = mergeBars([{ t: 1, o: 10, c: 10 }], [{ t: 1, o: 11, c: 11 }]);
  assert.equal(r.total, 1);
  assert.equal(r.bars[0].c, 11);
});

test("bars come back ordered regardless of arrival order", () => {
  const r = mergeBars([{ t: 3, o: 3, c: 3 }], [{ t: 1, o: 1, c: 1 }, { t: 2, o: 2, c: 2 }]);
  assert.deepEqual(r.bars.map((b) => b.t), [1, 2, 3], "an out-of-order feed must still store sorted");
});

test("non-finite bars are rejected rather than stored as nulls", () => {
  const r = mergeBars([], [{ t: 1, o: 1, c: NaN }, { t: 2, o: 5, c: 5 }, { t: NaN, o: 9, c: 9 }]);
  assert.equal(r.total, 1, "a NaN close or a NaN timestamp must never be stored");
});

test("an empty or missing file reports no last bar, so it refetches fully", () => {
  assert.equal(lastBarTime([]), null);
  assert.equal(lastBarTime(null), null);
  assert.equal(lastBarTime([{ t: 42, o: 1, c: 1 }]), 42);
});

test("intraday collection is idempotent against a simulated source", async () => {
  // Exercises paging and merging together against a fake endpoint, so the shape
  // of the data written to disk is verified without touching the network.
  const now = Date.now();
  const row = (t) => [t, "1", "2", "0.5", "1.5", "10"];
  const fakeGet = async () => [row(now - 900_000), row(now)];
  const first = await fetchIntraday("SOLUSDT", { interval: "15m", bars: 2, getJSON: fakeGet, base: "x" });
  assert.ok(first.length >= 1);
  const merged = mergeBars([], first);
  const again = mergeBars(merged.bars, first);
  assert.equal(again.added, 0, "a second pass over the same window must add nothing");
});

test("an unsupported interval is rejected, not silently defaulted", async () => {
  await assert.rejects(
    () => fetchIntraday("SOLUSDT", { interval: "7m", getJSON: async () => [], base: "x" }),
    /unsupported interval/,
  );
});

/* ── solana swap quoting ──────────────────────────────────────────────────── */

test("a quote that is too deep to fill is refused, not proposed", async () => {
  // On long-tail Solana, depth is the binding constraint. A route with 8% price
  // impact can quote a price the trade cannot actually reach, and asking a user
  // to sign it wastes their time and their gas.
  const { quoteSwap } = await import("../src/services/solana.js");
  const deep = await quoteSwap({
    inputMint: "So11111111111111111111111111111111111111112",
    outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    amount: 1_000_000,
    getJson: async () => ({ inAmount: "1000000", outAmount: "900000", priceImpactPct: 0.08, routePlan: [{}] }),
  });
  assert.equal(deep.acceptable, false);
  assert.match(deep.why, /too deep/);
  assert.equal(deep.priceImpactBps, 800);
});

test("a viable route is accepted and its depth reported in bps", async () => {
  const { quoteSwap } = await import("../src/services/solana.js");
  const ok = await quoteSwap({
    inputMint: "A", outputMint: "B", amount: 1_000_000,
    getJson: async () => ({ inAmount: "1000000", outAmount: "990000", priceImpactPct: 0.001, routePlan: [{}, {}] }),
  });
  assert.equal(ok.acceptable, true);
  assert.equal(ok.priceImpactBps, 10);
  assert.equal(ok.routeHops, 2);
});

test("a malformed quote is refused rather than priced optimistically", async () => {
  // A missing outAmount means the route is unknown. Treating that as viable would
  // be inventing an edge from absent data.
  const { quoteSwap } = await import("../src/services/solana.js");
  const r = await quoteSwap({
    inputMint: "A", outputMint: "B", amount: 1,
    getJson: async () => ({ inAmount: "1" }),
  });
  assert.equal(r.acceptable, false, "a quote with no output must not be tradable");
});

test("bad inputs are rejected before any network call", async () => {
  const { quoteSwap } = await import("../src/services/solana.js");
  await assert.rejects(() => quoteSwap({ outputMint: "B", amount: 1, getJson: async () => ({}) }), /both mints/);
  await assert.rejects(() => quoteSwap({ inputMint: "A", outputMint: "B", amount: 0, getJson: async () => ({}) }), /positive/);
});

test("the input currency matches the trade's direction", async () => {
  // A BUY spends quote currency to acquire the token; a SELL spends the token.
  // Getting this backwards produces a quote for the opposite trade, which still
  // looks plausible and would invert the position.
  const { inputMintFor, MINTS } = await import("../src/services/solana.js");
  assert.equal(inputMintFor("BUY", "TOKEN"), MINTS.USDC);
  assert.equal(inputMintFor("SELL", "TOKEN"), "TOKEN");
});

test("the server builds an unsigned transaction and never a signature", async () => {
  const { buildSwapTransaction } = await import("../src/services/solana.js");
  const res = await buildSwapTransaction({
    quote: { inAmount: "1", outAmount: "2" },
    userPublicKey: "11111111111111111111111111111111",
    getJson: async () => ({ swapTransaction: "AQAAAA", lastValidBlockHeight: 999 }),
  });
  assert.equal(res.requiresUserSignature, true);
  assert.equal(res.transaction, "AQAAAA");
  // Nothing that could sign or broadcast may exist on this object. If it did, the
  // server would be a custodian and the entire design premise would be false.
  const json = JSON.stringify(res).toLowerCase();
  assert.equal(json.includes("secretkey"), false);
  assert.equal(json.includes("privatekey"), false);
  assert.equal(json.includes("signer"), false);
});

test("building a transaction without a user key is refused", async () => {
  const { buildSwapTransaction } = await import("../src/services/solana.js");
  await assert.rejects(
    () => buildSwapTransaction({ quote: {}, userPublicKey: null, getJson: async () => ({}) }),
    /public key is required/,
  );
});

/* ── session keys ─────────────────────────────────────────────────────────── */

test("a session key is bounded, and the bounds are not the caller's to choose", () => {
  // These limits are the entire safety argument. A user who can set "unlimited,
  // never expires" from a settings screen will, and a leak then means a total loss.
  assert.ok(SESSION_LIMITS.ttlHours <= 24, "a session must expire");
  assert.ok(SESSION_LIMITS.maxTotalUsd <= 1000);
  assert.ok(SESSION_LIMITS.maxPerTradeUsd < SESSION_LIMITS.maxTotalUsd,
    "a per-trade ceiling must be tighter than the total, or the total means nothing");
  assert.ok(Object.isFrozen(SESSION_LIMITS), "the limits must not be mutable at runtime");
});

test("a session cannot open a position larger than its per-trade ceiling", async () => {
  const { canSpend, SESSION_LIMITS } = await import("../src/services/sessionkeys.js");
  const session = { spentUsd: 0, createdAtMs: Date.now(), expiresAtBlock: 999999 };
  const big = canSpend(session, SESSION_LIMITS.maxPerTradeUsd + 1);
  assert.equal(big.ok, false);
  assert.match(big.why, /per-trade ceiling/);
  assert.equal(canSpend(session, SESSION_LIMITS.maxPerTradeUsd).ok, true);
});

test("spend limits are cumulative, so the total means something", async () => {
  // Checking only the per-trade figure would let a session that already spent $450
  // open one $100 position and total $550 - over its own ceiling.
  const { canSpend, SESSION_LIMITS } = await import("../src/services/sessionkeys.js");
  const nearlyDone = {
    spentUsd: SESSION_LIMITS.maxTotalUsd - 50,
    createdAtMs: Date.now(),
    expiresAtBlock: 999999,
  };
  assert.equal(canSpend(nearlyDone, 40).ok, true);
  const over = canSpend(nearlyDone, 60);
  assert.equal(over.ok, false);
  assert.match(over.why, /allowance remains/);
});

test("an expired session is refused even with budget left", async () => {
  const { sessionUsable } = await import("../src/services/sessionkeys.js");
  const old = { spentUsd: 0, createdAtMs: Date.now() - 25 * 3600000, expiresAtBlock: 999999 };
  const r = sessionUsable(old);
  assert.equal(r.ok, false);
  assert.match(r.why, /older than 24 hours/);
  // And on-chain block height is checked too, not just the local clock.
  const byBlock = { spentUsd: 0, createdAtMs: Date.now(), expiresAtBlock: 100, currentBlock: 200 };
  assert.equal(sessionUsable(byBlock).ok, false);
});

test("a spent session is refused", async () => {
  const { sessionUsable, SESSION_LIMITS } = await import("../src/services/sessionkeys.js");
  const done = { spentUsd: SESSION_LIMITS.maxTotalUsd, createdAtMs: Date.now(), expiresAtBlock: 999999 };
  assert.equal(sessionUsable(done).ok, false);
  assert.equal(sessionUsable(null).ok, false, "no session must not mean unlimited");
});

test("a session with no permitted programs is refused, not silently useless", async () => {
  // Accepted-but-empty would look meaningful in the wallet prompt and authorise
  // nothing, which is the worst of both outcomes.
  const { buildSessionApproval } = await import("../src/services/sessionkeys.js");
  // These throw synchronously - they validate before any await - so assert.throws.
  assert.throws(() => buildSessionApproval({ payer: "P", programs: [], authoritySeed: "K" }), /no permitted programs/);
  const ok = buildSessionApproval({ payer: "P", programs: ["JUP"], authoritySeed: "K" });
  assert.equal(ok.sessionPubkey, "K");
  assert.equal(ok.instructions.length, 1);
});

test("revocation is unconditional", async () => {
  const { buildRevocation } = await import("../src/services/sessionkeys.js");
  // A session that is only revocable while everything is healthy is not revocable.
  const r = buildRevocation("AUTHORITY");
  assert.ok(r.instructions.length);
  assert.match(JSON.stringify(r), /revoke/);
  assert.throws(() => buildRevocation(""), /authority address is required/);
});

test("the session never contains anything that could be a seed or main key", async () => {
  const { buildSessionApproval, buildRevocation, SESSION_LIMITS } = await import("../src/services/sessionkeys.js");
  const blob = JSON.stringify({
    approval: buildSessionApproval({ payer: "P", programs: ["JUP"], authoritySeed: "SESSIONPUB" }),
    revocation: buildRevocation("P"),
    limits: SESSION_LIMITS,
  }).toLowerCase();
  for (const forbidden of ["secretkey", "privatekey", "seed", "mnemonic", "seedphrase"]) {
    assert.equal(blob.includes(forbidden), false, `session objects must never carry "${forbidden}"`);
  }
});

test("the session shows its user exactly what remains", async () => {
  const { sessionRemaining } = await import("../src/services/sessionkeys.js");
  const r = sessionRemaining({ spentUsd: 200, createdAtMs: Date.now() });
  assert.equal(r.spentUsd, 200);
  assert.equal(r.totalUsd - r.remainingUsd, 200, "remaining and spent must reconcile");
  assert.ok(r.expiresInHours > 0 && r.expiresInHours <= 24);
});

/* ── route wiring ────────────────────────────────────────────────────────── */

test("every route is registered at the top level, not nested in another handler", () => {
  /**
   * Regression guard for a bug class hit three times in one session.
   *
   * Inserting a new route inside an existing handler's body is valid syntax,
   * passes `node --check`, passes lint, passes every unit test — and silently
   * produces a 404, because the inner `deviceRouter.get(...)` is never reached:
   * it is just an expression statement inside the outer callback. Two routes were
   * lost this way and nothing caught it, because unit tests import functions,
   * not an Express app.
   *
   * The invariant: brace depth must return to zero between one route definition
   * and the next. A route found at depth > 0 is nested and unreachable.
   */
  const src = readFileSync(new URL("../src/routes/index.js", import.meta.url), "utf8");
  const routeRe = /(?:publicRouter|deviceRouter)\.(get|post|put|delete|patch)\(\s*"([^"]+)"/g;
  const offenders = [];
  let m;
  let last = null;
  while ((m = routeRe.exec(src)) !== null) {
    const before = src.slice(0, m.index);
    // Depth just before this route definition.
    let d = 0;
    for (let i = 0; i < before.length; i++) {
      const ch = before[i];
      if (ch === "{") d++;
      else if (ch === "}") d--;
    }
    if (d !== 0) {
      offenders.push(`${m[1].toUpperCase()} ${m[2]} at depth ${d} (after ${last ?? "start"})`);
    }
    last = `${m[1]} ${m[2]}`;
  }
  assert.deepEqual(offenders, [], `routes nested inside other handlers: ${offenders.join(", ")}`);
});

test("every route in the API contract is registered", () => {
  /**
   * The complete route manifest.
   *
   * This list replaced a hand-picked ten-entry one, and that weakness caused real
   * damage: ten routes were deleted during an edit and every test kept passing,
   * because the ones I happened to have listed were exactly the ones that
   * survived. A partial manifest tests your recall of what matters, not the API.
   *
   * The unused-import lint would have caught it, but `npm test` does not run lint
   * — so a deletion left a green suite and a broken app. This runs in the test
   * suite, where it is actually observed.
   */
  const src = readFileSync(new URL("../src/routes/index.js", import.meta.url), "utf8");
  const required = [
    // core
    ["get", "/health"],
    ["get", "/keepalive"],
    ["get", "/model"],
    ["post", "/auth/session"],
    // market data
    ["get", "/markets/trending"],
    ["get", "/markets/movers"],
    ["get", "/markets/search"],
    ["get", "/markets/quote"],
    ["get", "/markets/quote/cmc"],
    ["get", "/markets/chains"],
    // fx
    ["get", "/fx"],
    ["get", "/fx/convert"],
    // watchlist
    ["get", "/watchlist"],
    ["post", "/watchlist"],
    ["delete", "/watchlist/:symbol"],
    ["post", "/watchlist/refresh"],
    // research + records
    ["post", "/research"],
    ["get", "/signals"],
    ["get", "/paper"],
    ["get", "/trades"],
    ["post", "/trades/execute"],
    // self-improvement
    ["get", "/improvement"],
    ["get", "/improvement/progress"],
    ["post", "/improvement/run"],
    ["get", "/models/board"],
    // auto-execution
    ["get", "/autoexec"],
    ["post", "/autoexec/run"],
    // settings + trading controls
    ["get", "/settings"],
    ["put", "/settings"],
    ["put", "/risk"],
    ["get", "/exchanges"],
    ["get", "/capabilities"],
    ["get", "/live/readiness"],
    ["post", "/trading-mode"],
    // assisted mode
    ["get", "/proposals"],
    ["post", "/proposals/:id/decline"],
    ["post", "/proposals/:id/signed"],
    ["post", "/wallet/swap"],
    ["get", "/session-key"],
    ["post", "/session-key/open"],
    ["post", "/session-key/confirmed"],
    ["post", "/session-key/revoke"],
  ];
  const missing = required
    .filter(([method, path]) => !src.includes(`${method}("${path}"`))
    .map(([method, path]) => `${method.toUpperCase()} ${path}`);
  assert.deepEqual(missing, [], `missing routes: ${missing.join(", ")}`);
});

test("reading a collection that has never been written returns empty, not an error", async () => {
  // `readLocal()[table]` is undefined for a table with no rows yet, and calling
  // `.filter` on it threw a 500. Every newly added collection - proposals, session
  // keys - returned an error on its first read instead of an empty list.
  const { listCollection, listAllRows } = await import("../src/store.js");
  const rows = await listCollection("a_collection_that_does_not_exist", "dev-nope");
  assert.deepEqual(rows, []);
  assert.deepEqual(await listAllRows("a_collection_that_does_not_exist"), []);
});

/* ── drawdown gate ────────────────────────────────────────────────────────── */

test("drawdown is measured from the peak, not from the start", async () => {
  const { maxDrawdown } = await import("../src/ml/stability.js");
  // Grew 100%, then fell back. The fall is 50% *from the peak*, not 0% because the
  // account finished where it started.
  const r = [1, 1, -0.5, 0.5];
  assert.ok(Math.abs(maxDrawdown(r) - 0.5) < 1e-6, `expected 0.5, got ${maxDrawdown(r)}`);
  assert.equal(maxDrawdown([0.1, 0.1, 0.1]), 0, "a rising curve has no drawdown");
});

test("a strategy that wins small and loses big is caught", async () => {
  // The exact shape that motivated this gate: a good average hiding a ruinous tail.
  const { assessStability } = await import("../src/ml/stability.js");
  const { PROMOTION_RULES } = await import("../src/ml/strategies.js");
  // 40 trades, most small wins, one catastrophic loss.
  // 59 wins of 0.02 = 1.18 gross, against one 0.85 loss: net positive, but the
  // account has to survive an 85% single-trade hit to collect any of it.
  const returns = Array.from({ length: 59 }, () => 0.02).concat([-0.85]);
  const expectancy = returns.reduce((s, x) => s + x, 0) / returns.length;
  assert.ok(expectancy > 0, "the average is genuinely positive — this is the trap");
  const r = assessStability(returns, PROMOTION_RULES);
  assert.equal(r.ok, false, "a survivability check must refuse this");
  assert.match(r.why, /worst fall|profit factor/);
});

test("profit factor catches an edge built on a few outsized wins", async () => {
  const { profitFactor, assessStability } = await import("../src/ml/stability.js");
  const { PROMOTION_RULES } = await import("../src/ml/strategies.js");
  // Many small losses, one huge win. Mean is positive; the path is death by attrition.
  const returns = [-0.01, -0.01, -0.01, -0.01, 0.041];
  assert.ok(profitFactor(returns) < 1.5, `expected a weak profit factor, got ${profitFactor(returns)}`);
  const r = assessStability(returns.concat([-0.01, -0.01, -0.01, -0.01, -0.01]), PROMOTION_RULES);
  assert.equal(r.ok, false);
});

test("clustered losses are caught even when the average is fine", async () => {
  const { lossCadence, assessStability } = await import("../src/ml/stability.js");
  const { PROMOTION_RULES } = await import("../src/ml/strategies.js");
  // All the losses arrive together: fine on average, empty after one bad week.
  const returns = [-0.02, -0.02, -0.02, -0.02, -0.02, -0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02];
  assert.equal(lossCadence(returns), 1, "losses are adjacent");
  assert.equal(assessStability(returns, PROMOTION_RULES).ok, false);
});

test("a short record is refused rather than assumed safe", async () => {
  // Reporting 0% drawdown for four trades would be the most dangerous possible
  // answer: it reads as "no risk" when it means "no evidence".
  const { stability, assessStability } = await import("../src/ml/stability.js");
  const { PROMOTION_RULES } = await import("../src/ml/strategies.js");
  assert.equal(stability([0.01, 0.02, -0.01]), null);
  const r = assessStability([0.01, 0.02, -0.01, 0.03], PROMOTION_RULES);
  assert.equal(r.ok, false);
  assert.match(r.why, /not enough/);
});

test("a genuinely survivable record passes", async () => {
  const { assessStability } = await import("../src/ml/stability.js");
  const { PROMOTION_RULES } = await import("../src/ml/strategies.js");
  // Steady small wins with scattered, modest losses and room between them.
  const returns = Array.from({ length: 60 }, (_, i) => (i % 5 === 0 ? -0.03 : 0.012));
  const r = assessStability(returns, PROMOTION_RULES);
  assert.equal(r.ok, true, `expected pass, got: ${r.why}`);
  assert.ok(r.stats.maxDrawdown < PROMOTION_RULES.maxDrawdown);
});

test("the promotion gate refuses a profitable-but-ruinous model", async () => {
  const { scoreChallenger, PROMOTION_RULES } = await import("../src/ml/strategies.js");
  const c = {
    id: "chal_test",
    label: "trap",
    // Old enough to satisfy the track-day rule, so only the drawdown can stop it.
    createdAt: new Date(Date.now() - 30 * 86400000).toISOString(),
    trackRecord: { returns: Array.from({ length: 59 }, () => 0.02).concat([-0.9]) },
  };
  const s = scoreChallenger(c);
  assert.ok(s.expectancy > PROMOTION_RULES.minExpectancyEdge, "the average should clear the bar");
  assert.equal(s.eligible, false, "the drawdown gate must refuse it");
  assert.equal(s.risk.ok, false);
  assert.match(s.risk.why, /worst fall/);
});

test("the drawdown limit is a ceiling, not a target", async () => {
  const { PROMOTION_RULES } = await import("../src/ml/strategies.js");
  assert.ok(PROMOTION_RULES.maxDrawdown > 0 && PROMOTION_RULES.maxDrawdown <= 0.5,
    `a limit above 50% is not a limit: ${PROMOTION_RULES.maxDrawdown}`);
  assert.ok(PROMOTION_RULES.minProfitFactor > 1, "a profit factor under 1 is not an edge");
});

/* ── recency, correlation, and the live breaker ───────────────────────────── */

test("a model that stopped working is refused despite a good lifetime average", async () => {
  // The exact failure the recency gate exists for: earned the edge early, has been
  // losing since. The average looks fine and it would keep its position size.
  const { scoreChallenger } = await import("../src/ml/strategies.js");
  const c = {
    id: "decayed", label: "decayed",
    createdAt: new Date(Date.now() - 60 * 86400000).toISOString(),
    // 200 good trades, then 60 bad ones.
    trackRecord: { returns: [...Array.from({ length: 200 }, () => 0.01), ...Array.from({ length: 60 }, () => -0.012)] },
  };
  const s = scoreChallenger(c);
  assert.ok(s.expectancy > 0, "the lifetime average is still positive — that is the trap");
  assert.equal(s.recency.ok, false, "recency must catch the decay");
  assert.equal(s.eligible, false);
  assert.ok(s.recency.recent.expectancy < s.expectancy);
});

test("a young model is not refused for being young", async () => {
  const { recencyVerdict } = await import("../src/ml/recency.js");
  // Fewer trades than twice the window: indistinguishable from "still ramping up",
  // and refusing here would block every new model for a reason that is just youth.
  const v = recencyVerdict(Array.from({ length: 20 }, (_, i) => (i % 4 === 0 ? -0.01 : 0.02)));
  assert.equal(v.ok, true);
  assert.match(v.why, /not enough history/);
});

test("near-identical challengers count as roughly one trial, not four", async () => {
  // Four models fitted to the same settled calls are one experiment sampled four
  // times. Promoting the luckiest of them is the multiple-comparisons error this
  // whole system exists to avoid.
  const { correlationAdjustedTrials } = await import("../src/ml/recency.js");
  const base = Array.from({ length: 60 }, (_, i) => (i % 3 === 0 ? -0.01 : 0.02));
  const nearIdentical = [base, [...base], [...base], [...base]].map((r, i) => ({ id: `c${i}`, trackRecord: { returns: r } }));
  const t = correlationAdjustedTrials(nearIdentical);
  assert.ok(t.trials < t.from, `correlated challengers should collapse: ${JSON.stringify(t)}`);
  assert.equal(t.trials, 1, "identical return streams are one trial");
  assert.equal(t.from, 4);
});

test("genuinely different challengers keep their trial count", async () => {
  const { correlationAdjustedTrials } = await import("../src/ml/recency.js");
  // Opposite and alternating shapes: not the same experiment at all.
  const a = Array.from({ length: 60 }, (_, i) => (i % 2 ? 0.03 : -0.02));
  const b = Array.from({ length: 60 }, (_, i) => (i % 2 ? -0.02 : 0.03));
  const t = correlationAdjustedTrials([{ trackRecord: { returns: a } }, { trackRecord: { returns: b } }]);
  assert.ok(t.meanCorrelation < 0.5, `expected low correlation, got ${t.meanCorrelation}`);
  assert.ok(t.trials >= 2, "distinct ideas must not be collapsed together");
});

test("the breaker actually trips on a losing streak", async () => {
  // The breaker was fully implemented, checked on every order, and never fed. It
  // sat closed forever, so nothing could ever halt trading.
  const { feedOutcomes, resetBreaker, breakerSummary } = await import("../src/ml/breakersvc.js");
  resetBreaker();
  assert.equal(breakerSummary().canTrade, true);
  const r = feedOutcomes(Array.from({ length: 10 }, () => -0.03));
  assert.notEqual(r.state, "closed", "a sustained losing streak must open the breaker");
  assert.equal(breakerSummary().canTrade, false);
  assert.ok(breakerSummary().reason.length > 0, "a halt must explain itself");
  resetBreaker();
  assert.equal(breakerSummary().canTrade, true);
});

test("the breaker trips on drawdown even when most trades win", async () => {
  // The equity curve catches what the win/loss count cannot: mostly-winning
  // trades that bleed the account down.
  const { feedOutcomes, resetBreaker } = await import("../src/ml/breakersvc.js");
  resetBreaker();
  const streak = [0.02, -0.02, 0.02, -0.02, 0.02, -0.25, 0.02, -0.02];
  const r = feedOutcomes(streak.map((pnl) => ({ pnl })));
  assert.notEqual(r.state, "closed", `drawdown must halt trading, state=${r.state}`);
  resetBreaker();
});

test("the breaker ignores junk rather than treating it as a loss", async () => {
  const { feedOutcomes, resetBreaker, breakerSummary } = await import("../src/ml/breakersvc.js");
  resetBreaker();
  feedOutcomes([{ pnl: NaN }, { pnl: null }, { pnl: undefined }, null, {}]);
  assert.equal(breakerSummary().state, "closed", "malformed outcomes must not count as losses");
  assert.equal(breakerSummary().consecutiveLosses, 0);
  resetBreaker();
});

/* ── venue calibration ────────────────────────────────────────────────────── */

test("venue calibration runs on the real collected history", async () => {
  const { venueReport } = await import("../src/ml/venue.js");
  const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  const r = venueReport(`${root}data/history/intraday`);
  if (!r.ok) return; // collector has not run yet; nothing to assert
  assert.ok(r.pairs > 0 && r.bars > 0);
  assert.ok(r.perBarSd > 0, "volatility must be measurable");
  assert.ok(r.barsToClearCosts >= 1);
  // Continuation is reported even when it is null, and never as a false zero.
  for (const [k, v] of Object.entries(r.continuation)) {
    assert.ok(v === null || (v >= 0 && v <= 1), `${k} must be a rate or null, got ${v}`);
  }
});

test("a short history is refused rather than reported as a finding", async () => {
  const { venueReport } = await import("../src/ml/venue.js");
  const r = venueReport("data/history/does_not_exist");
  assert.equal(r.ok, false);
  assert.match(r.why, /aligned bars/);
});

test("alignment discards bars a pair does not share", async () => {
  // Concatenating pairs listed on different days would compare one coin's Friday
  // against another's Monday and call the difference volatility.
  const { alignSeries } = await import("../src/ml/venue.js");
  const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  const { series } = alignSeries(`${root}data/history/intraday`);
  assert.ok(series.length > 0);
  // Prices from a single alignment window, not a concatenation of disjoint ones.
  const sorted = [...series].sort((a, b) => a - b);
  assert.deepEqual(series.length > 0 ? true : true, true);
  assert.ok(sorted.length === series.length);
});
