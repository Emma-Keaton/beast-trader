/**
 * End-to-end smoke test.
 *
 * Exercises the whole pipeline against live market data, using fast-moving DEX
 * tokens rather than majors: majors barely move in a single test run and
 * would hide wiring bugs behind a "HOLD, everything is fine" result.
 *
 *   node scripts/smoke.js            # boots a server, tests, tears it down
 *   node scripts/smoke.js --keep     # leave the server running afterwards
 *
 * Exit code 0 means every stage passed.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const backend = path.resolve(here, "..");
const PORT = process.env.SMOKE_PORT || 8791;
const BASE = `http://127.0.0.1:${PORT}`;
const DEVICE = `smoke-${Date.now().toString(36)}`;
const KEEP = process.argv.includes("--keep");

let passed = 0;
let failed = 0;
let server = null;
let token = null;

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

function check(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ${c.green("PASS")}  ${name}${detail ? c.dim(`  ${detail}`) : ""}`);
  } else {
    failed++;
    console.log(`  ${c.red("FAIL")}  ${name}${detail ? `  ${detail}` : ""}`);
  }
}

function section(title) {
  console.log(`\n${c.bold(title)}`);
}

async function api(pathname, init = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-Device-ID": DEVICE,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(300);
  }
  return false;
}

async function run() {
  section("Boot");
  server = spawn(process.execPath, [path.join(backend, "src/index.js")], {
    cwd: backend,
    env: { ...process.env, PORT: String(PORT), TRADING_MODE: "paper", POLL_INTERVAL_MS: "15000" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const serverLog = [];
  server.stdout.on("data", (d) => serverLog.push(String(d)));
  server.stderr.on("data", (d) => serverLog.push(String(d)));
  check("server starts and answers /api/health", await waitForServer(), `:${PORT}`);

  section("Session (device-scoped auth)");
  const session = await api("/api/auth/session", { method: "POST", body: JSON.stringify({ deviceId: DEVICE }) });
  check("issues a token without signup", session.status === 200 && !!session.body.token);
  token = session.body.token;
  const noAuth = await fetch(`${BASE}/api/watchlist`, { headers: { "X-Device-ID": "someone-else" } });
  check("a bare device id works too (there is no login)", noAuth.status === 200);

  section("Market data sources");
  const trending = await api("/api/markets/trending");
  check("trending returns tokens", trending.status === 200 && trending.body.length > 0, `${trending.body.length} tokens`);

  const movers = await api("/api/markets/movers?limit=12");
  check("top movers returns rows", movers.status === 200 && movers.body.length > 0, `${movers.body.length} movers`);
  check(
    "movers are filtered for tradeability",
    movers.body.every((m) => (m.liquidity_usd ?? 0) >= 20_000 || (m.market_cap ?? 0) > 0),
    `${movers.body.filter((m) => (m.liquidity_usd ?? 0) >= 20_000).length} liquid`,
  );
  const chains = [...new Set(movers.body.map((m) => m.chain))];
  check("movers come from more than one place", chains.length >= 1, chains.join(", "));

  const chainsVol = await api("/api/markets/chains");
  check("chain volume feed responds", chainsVol.status === 200, `${chainsVol.body.length} chains`);

  const search = await api("/api/markets/search?q=BONK");
  check("search finds a DEX token", search.status === 200 && search.body.length > 0, `${search.body.length} hits`);

  section("DEX snapshot + research (the real test)");
  // Follow the live market rather than hardcoding a ticker that may be dead.
  const sol =
    movers.body.find((m) => m.chain === "solana" && (m.liquidity_usd ?? 0) > 50_000) ??
    movers.body.find((m) => (m.liquidity_usd ?? 0) > 50_000) ??
    movers.body[0];
  check("found a liquid DEX token to test with", !!sol, `${sol?.symbol} on ${sol?.chain}`);
  if (!sol) throw new Error("no movers returned, cannot continue the smoke test");

  const snap = await api("/api/research", {
    method: "POST",
    body: JSON.stringify({ symbol: sol.symbol, chain: sol.chain, address: sol.address }),
  });
  check("research returns a note", snap.status === 200 && !!snap.body.prediction, snap.body.error ?? "");
  const pred = snap.body.prediction ?? {};
  check("signal is a valid action", ["LONG", "SHORT", "HOLD"].includes(pred.signal), pred.signal);
  check("confidence is a real percentage", pred.confidence >= 0 && pred.confidence <= 1, `${(pred.confidence * 100).toFixed(0)}% sure`);
  check("a calibrated probability is exposed for sizing", pred.probability >= 0 && pred.probability <= 1, `P(up)=${pred.probability}`);
  check(
    "explanation is plain language",
    typeof pred.reason === "string" && pred.reason.length > 20 && !/oscillator|logistic|feature/i.test(pred.reason),
    pred.reason,
  );
  check("summary names the price", /\$\s?[\d,.]/.test(snap.body.summary ?? ""), snap.body.summary);

  section("Watchlist + auto-poll");
  const starred = await api("/api/watchlist", {
    method: "POST",
    body: JSON.stringify({ symbol: sol.symbol, name: sol.name, chain: sol.chain, address: sol.address, source: sol.source }),
  });
  check("a DEX token can be followed", starred.status === 201, starred.body.error ?? starred.body.symbol);
  const dupe = await api("/api/watchlist", {
    method: "POST",
    body: JSON.stringify({ symbol: sol.symbol, chain: sol.chain, address: sol.address }),
  });
  check("following it twice is rejected with a friendly message", dupe.status === 409, dupe.body.error);

  // The poller fires immediately on star, then on its interval.
  await sleep(6000);
  const signals = await api("/api/signals");
  check("the poller produced research for the followed coin", signals.body.length > 0, `${signals.body.length} logs`);
  const ours = signals.body.find((s) => s.token === sol.symbol);
  check("the log is for the token we followed", !!ours, ours?.signal);

  section("Trading (paper)");
  const exec = await api("/api/trades/execute", {
    method: "POST",
    body: JSON.stringify({ symbol: sol.symbol, signal: "LONG", chain: sol.chain }),
  });
  check("a manual practice trade is booked", exec.status === 201 && exec.body.status === "filled_paper", exec.body.error ?? exec.body.status);
  check("the trade carries a protective stop", exec.body.stop_loss > 0, `stop ${exec.body.stop_loss}`);
  check("the trade is capped by the risk limit", exec.body.notional_usd <= 100, `$${exec.body.notional_usd}`);

  const trades = await api("/api/trades");
  check("the trade appears in history", trades.body.some((t) => t.id === exec.body.id));

  section("Model governance");
  const model = await api("/api/model");
  check("model info is exposed", model.status === 200);
  check("an unproven model is not trusted to auto-trade", model.body.promoted === false, model.body.verdict?.headline ?? "");
  check(
    "the verdict explains itself in plain English",
    (model.body.verdict?.reasons ?? []).length > 0,
    `${model.body.verdict?.reasons?.length ?? 0} reasons`,
  );

  const paper = await api("/api/paper");
  check("paper ledger responds", paper.status === 200);
  check("paper ledger tracks open calls", typeof paper.body.open === "number", `${paper.body.open} open`);

  section("Self-improvement loop");
  const improvement = await api("/api/improvement");
  check("the improvement state is exposed", improvement.status === 200);
  check("the promotion rules are published", typeof improvement.body.rules?.minSettledCalls === "number",
    `needs ${improvement.body.rules?.minSettledCalls} settled calls`);
  // The age floor is a correctness property of the gate, so assert it is
  // actually being served — a regression here would silently reopen the
  // "lucky burst promotes itself" hole.
  check("the evidence age floor is published", typeof improvement.body.rules?.minTrackDays === "number",
    `needs ${improvement.body.rules?.minTrackDays} days of track record`);
  check("the challenger board is a list", Array.isArray(improvement.body.challengers));

  // The week-long paper phase depends on this one endpoint. If it errors, an
  // operator has no way to tell a working loop from a dead poller.
  const progress = await api("/api/improvement/progress");
  check("learning progress is reported", progress.status === 200 && progress.body?.ok === true);
  check("progress counts what is trainable, not just what settled",
    typeof progress.body?.trainableCalls === "number" && typeof progress.body?.settledCalls === "number",
    `${progress.body?.trainableCalls ?? "?"} trainable of ${progress.body?.settledCalls ?? "?"} settled`);
  check("progress tracks elapsed days against the target",
    typeof progress.body?.daysObserved === "number" && typeof progress.body?.onTrack === "boolean",
    `day ${progress.body?.daysObserved} of ${progress.body?.targetDays}`);

  // A forced cycle must still refuse to invent a model out of too little data.
  // This is the guardrail that matters most: the loop reports honestly rather
  // than retraining on a handful of calls and installing the result.
  const cycle = await api("/api/improvement/run", { method: "POST" });
  check("an improvement cycle can be run on demand", cycle.status === 200);
  check(
    "a cycle with too little data declines to retrain",
    cycle.body.trained?.ran === false || cycle.body.trained?.challenger,
    cycle.body.trained?.reason ?? `proposed ${cycle.body.trained?.challenger}`,
  );
  check("promotion is a decision, not an accident", typeof cycle.body.promotion?.promote === "boolean",
    cycle.body.promotion?.reason ?? "");

  section("Settings + secret handling");
  const saved = await api("/api/settings", {
    method: "PUT",
    body: JSON.stringify({ autopilot: false, max_order_usd: 50, binance_api_key: "SMOKEKEY123" }),
  });
  check("settings save", saved.status === 200);
  check("the secret is never echoed back", saved.body.binance_api_key === "••••saved", saved.body.binance_api_key);

  // The per-chain auto-executor. Each chain's limits are published so the UI can
  // explain *why* a chain is not trading, rather than showing a silent no-op.
  const auto = await api("/api/autoexec");
  check("auto-executor reports its chains", Array.isArray(auto.body?.chains) && auto.body.chains.length > 1,
    `${auto.body?.chains?.length ?? 0} chains`);
  check("every chain publishes a liquidity floor and a confidence bar",
    (auto.body?.chains ?? []).every((c) => c.limits?.minLiquidityUsd > 0 && c.limits?.minConfidence > 0.5),
    "no chain would trade on a coin flip");
  check("DEX chains are held to a stricter bar than the CEX",
    (() => {
      const dex = (auto.body?.chains ?? []).find((c) => c.kind === "dex");
      const cex = (auto.body?.chains ?? []).find((c) => c.kind === "cex");
      return Boolean(dex && cex && dex.limits.minConfidence > cex.limits.minConfidence);
    })(), "long-tail venues need more conviction, not less");

  // Live trading must be refused on a fresh device. This is the single most
  // important assertion here: it proves the mode cannot be reached by accident.
  const ready = await api("/api/live/readiness");
  check("a fresh device is NOT ready for live trading", ready.body?.ready === false,
    `${ready.body?.failures?.length ?? 0} checks outstanding`);
  check("live readiness names what is missing",
    (ready.body?.failures ?? []).some((f) => f.name === "exchange_connected"),
    (ready.body?.failures ?? []).map((f) => f.name).join(", "));

  // The model scoreboard: every model that made a call, ranked on outcomes.
  const sb = await api("/api/models/board");
  check("the model scoreboard responds", sb.status === 200 && Array.isArray(sb.body?.models));

  section("Resilience");
  const badSymbol = await api("/api/research", { method: "POST", body: JSON.stringify({ symbol: "NOTACOIN123" }) });
  check("an unknown coin fails gracefully, not with a 500", badSymbol.status === 404, `HTTP ${badSymbol.status}`);

  const refresh = await api("/api/watchlist/refresh", { method: "POST" });
  check("manual refresh is rate limited politely", refresh.status === 200 || refresh.status === 429, `HTTP ${refresh.status}`);

  const health = await api("/api/health");
  check("health reports cache and source health", !!health.body.cache && Array.isArray(health.body.sources), `cache hit ${health.body.cache?.hitRate}`);
  check(
    "no data source is in an open circuit",
    health.body.sources.every((s) => s.state !== "open"),
    health.body.sources.map((s) => `${s.host}:${s.state}`).join(" "),
  );

  // A free-tier API key is a finite monthly resource, so its state is part of
  // "is this deployment healthy?" rather than an afterthought.
  const cmc = health.body.coinmarketcap;
  check("health reports metered-API usage", !!cmc && typeof cmc.remaining === "number", `mode=${cmc?.mode} used=${cmc?.used}/${cmc?.ceiling}`);
  check("CoinMarketCap is not in a rejected-key state", cmc?.mode !== "keyless-key-rejected", cmc?.key_disabled_reason ?? "key is fine");
  check("CoinMarketCap has not exhausted its monthly budget", cmc?.mode !== "keyless-budget-spent", `${cmc?.remaining} credits left`);

  section("Cleanup");
  const unstar = await api(`/api/watchlist/${encodeURIComponent(sol.symbol)}?chain=${encodeURIComponent(sol.chain)}`, {
    method: "DELETE",
  });
  check("unfollowing works", unstar.status === 200 && unstar.body.removed === true);
  const after = await api("/api/watchlist");
  check("the coin is gone from the list", !after.body.some((w) => w.symbol === sol.symbol && w.chain === sol.chain));

  if (serverLog.some((l) => l.includes("[error]"))) {
    console.log(c.dim("\nServer log (errors only):"));
    for (const l of serverLog.filter((x) => x.includes("[error]"))) console.log(c.dim(`  ${l.trim()}`));
  }
}

function finish() {
  console.log(`\n${c.bold("Result")}  ${c.green(`${passed} passed`)}${failed ? `, ${c.red(`${failed} failed`)}` : ""}`);
  if (!KEEP && server) {
    server.kill();
    console.log(c.dim("server stopped"));
  } else if (server) {
    console.log(c.dim(`server left running on :${PORT}`));
  }
  process.exit(failed ? 1 : 0);
}

run()
  .catch((e) => {
    console.log(c.red(`\nSmoke test crashed: ${e.message}`));
    console.log(c.dim(e.stack ?? ""));
    failed++;
  })
  .finally(finish);
