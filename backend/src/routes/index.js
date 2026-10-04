import { Router } from "express";
import { issueToken } from "../auth.js";
import { config, usingSupabase } from "../config.js";
import { deleteRow, encryptSecret, getSettings, insertRow, listCollection, putSettings, verifySupabase } from "../store.js";
import { setTradingMode } from "../services/gate.js";
import { SUPPORTED_EXCHANGES } from "../services/exchange.js";
import { PROPOSAL_STATUS, isLive } from "../services/assisted.js";
import { applyRiskProfile, describeProfile } from "../ml/riskprofile.js";
import { capabilities, describeCapabilities, TRADING_MODES, AUTHORITIES, CUSTODIES } from "../services/capabilities.js";
import { quoteSwap, buildSwapTransaction } from "../services/solana.js";
import { SESSION_LIMITS, buildSessionApproval, buildRevocation, sessionUsable, sessionRemaining } from "../services/sessionkeys.js";

/**
 * Venues whose API requires a passphrase alongside key and secret.
 *
 * Kept beside the exchange list rather than inside the UI. OKX always requires one
 * and KuCoin requires it on some account configurations; getting this wrong is an
 * authentication failure at connect time, which is exactly the moment a user is
 * least able to guess why.
 */
const PASSPHRASE_VENUES = new Set(["okx", "kucoin"]);
import {
  allMovers,
  bestPair,
  cache,
  chainVolume,
  cmcQuotes,
  search as searchTokens,
  trending as trendingCrypto,
} from "../services/data.js";
import { marketSnapshot, crossCheck } from "../services/snapshot.js";
import { clientHealth } from "../core/http.js";
import { research } from "../services/research.js";
import { executeOrder, planOrder, liveTradingEnabled } from "../services/executor.js";
import { manualRefresh, runOnce } from "../services/poller.js";
import { modelInfo } from "../ml/registry.js";
import { paperStats } from "../ml/paper.js";
import { board } from "../ml/scoreboard.js";
import { runAutoExecutor, status as autoexecStatus, readiness as liveReadinessFor } from "../services/autoexec.js";
import { improvementReport, learningProgress, runImprovementCycle } from "../services/improve.js";

/**
 * Express 4 does not await async handlers, so a rejected promise never
 * reaches the error middleware and the request hangs until it times out.
 * `ah` forwards rejections so every route fails fast and predictably.
 */
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const OFFLINE = "We can't reach the market data right now. Please try again in a moment.";

/** Public router: health, device-session issue, market discovery. */
import { SUPPORTED, convert, fxRates } from "../services/fx.js";
import { cmcStatus } from "../services/cmc.js";

export const publicRouter = Router();

/**
 * Health must answer "is this working", not "is this configured".
 *
 * It previously reported `storage: supabase` whenever a URL and key were
 * *present*, which stayed true through a 401 on every single write. A health
 * endpoint that claims "connected" while the app is silently losing data is
 * worse than one that says nothing, so this performs one cheap authenticated
 * round trip and reports what actually happened.
 *
 * Deliberately async now. A health check that cannot detect its own database
 * being unreachable is not a health check.
 */
publicRouter.get("/health", async (_req, res) => {
  const supabase = await verifySupabase();
  res.json({
    // `ok` reflects reality: a configured-but-rejected database is not a healthy
    // deployment, whatever else is working.
    ok: supabase.connected || supabase.status === "not_configured",
    mode: config.tradingMode,
    // Which network live orders would hit. Surfaced because "why is it in
    // testnet" is a question a health endpoint should be able to answer rather
    // than something you have to go read config.js to find out.
    network: config.network,
    live_enabled: liveTradingEnabled(),
    // The honest word: "supabase" only once it has actually answered.
    storage: supabase.connected ? "supabase" : "local",
    // True if credentials are set, regardless of whether they work.
    storageConfigured: usingSupabase,
    storageDetail: supabase,
    poll_interval_ms: config.pollIntervalMs,
    model: modelInfo(),
    cache: cache.stats(),
    sources: clientHealth(),
    // Metered-API usage, so a free-tier key can be watched rather than
    // discovered the hard way when it runs out. `mode` says which API is
    // actually answering: "keyed", "keyless" (no key configured),
    // "keyless-key-rejected" (bad key) or "keyless-budget-spent" (allowance
    // used up for this month).
    coinmarketcap: cmcStatus(),
  });
});

/**
 * Uptime ping. Returns immediately with no data and touches no upstream.
 *
 * It exists so an external monitor can tell "the process is up" from "the app is
 * healthy". Deliberately does not call `verifySupabase()` — an uptime probe that
 * waits on a database round trip every 15 seconds adds load and can fail on a
 * transient provider blip, which is not what an uptime monitor should mean.
 */
publicRouter.get("/keepalive", (_req, res) => {
  res.json({ ok: true, at: new Date().toISOString() });
});

/** Metadata about the loaded model: trained, promoted, which version, when. */
publicRouter.get("/model", (_req, res) => {
  res.json(modelInfo());
});

/**
 * Exchange the device id for a 30-day JWT.
 *
 * The client sends its own id back, but the id also arrives as `X-Device-ID`.
 * Preferring the header over the body closes the easy forgery: a script can
 * claim any body it likes, and the header is what every later request will send.
 */
publicRouter.post("/auth/session", (req, res) => {
  const deviceId = req.get("X-Device-ID") || req.body?.deviceId;
  if (!deviceId) {
    return res.status(400).json({ error: "a device id is required" });
  }
  res.json({ token: issueToken(deviceId), expiresInDays: config.jwtTtlDays });
});

/**
 * Wrap a market-data handler so an upstream failure answers a readable message.
 *
 * The app hits rate limits and missing listings constantly — they are normal
 * states, not errors in this server. Passing them to `next()` produced a raw 500,
 * which makes the dashboard look broken when it is merely waiting out a rate
 * limit. `OFFLINE` was written for exactly this and was left orphaned when these
 * routes were deleted.
 *
 * Returns 503 rather than 500: the server is fine, the upstream is not.
 */
const market = (fn) => ah(async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    console.warn(`[market] ${req.path}: ${err.message}`);
    res.status(503).json({ error: OFFLINE });
  }
});
/* ── market data. Every one of these is cached and degrades to null/[] rather
   than throwing, because a rate-limited or absent upstream is a normal state —
   the dashboard showing an empty board is correct, and a 500 is not. ────────── */

publicRouter.get("/markets/trending", market(async (_req, res) => {
  // `trending()` is not declared async but returns `cache.fetch(...)`, a promise.
  // Without the await, `res.json` receives a Promise and serialises it to `{}`.
  res.json((await trendingCrypto()) ?? []);
}));

publicRouter.get("/markets/movers", market(async (req, res) => {
  const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 12));
  res.json((await allMovers(limit)) ?? []);
}));

publicRouter.get("/markets/search", market(async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  if (!q) return res.json([]);
  res.json((await searchTokens(q)) ?? []);
}));

/** Best available pair for a symbol, optionally pinned to one chain. */
publicRouter.get("/markets/quote", market(async (req, res) => {
  const symbol = String(req.query.symbol ?? "").trim();
  if (!symbol) return res.status(400).json({ error: "symbol is required" });
  const pair = await bestPair(symbol, req.query.chain ? String(req.query.chain) : undefined);
  if (!pair) return res.status(404).json({ error: `no pair found for ${symbol}` });
  res.json(pair);
}));

/** CoinMarketCap quote, used to cross-check a DEX price rather than trust one. */
publicRouter.get("/markets/quote/cmc", market(async (req, res) => {
  const symbol = String(req.query.symbol ?? "").trim();
  if (!symbol) return res.status(400).json({ error: "symbol is required" });
  const quote = await cmcQuotes(symbol);
  if (!quote) return res.status(404).json({ error: `no CMC quote for ${symbol}` });
  res.json(quote);
}));

/**
 * Per-chain DEX volume, for the volume context the dashboard shows.
 *
 * `chainVolume` fetches one chain, so this route fans out over a small fixed set
 * and drops failures rather than failing the whole response — one dead DefiLlama
 * slug should not empty the panel.
 */
const VOLUME_CHAINS = ["solana", "ethereum", "base", "bsc", "arbitrum", "polygon", "sui"];
publicRouter.get("/markets/chains", market(async (_req, res) => {
  const rows = [];
  for (const c of VOLUME_CHAINS) {
    try {
      const v = await chainVolume(c);
      if (v) rows.push(v);
    } catch {
      // A chain that errors is simply absent from the panel.
    }
  }
  res.json(rows);
}));

/* ── FX ─────────────────────────────────────────────────────────────────────── */

/** All available USD rates. Cached; `null` when the rate provider is down. */
publicRouter.get("/fx", ah(async (_req, res) => {
  res.json((await fxRates()) ?? null);
}));

/** Convert a USD amount into a currency. Always returns a shape the UI can read. */
publicRouter.get("/fx/convert", ah(async (req, res) => {
  const usd = Number(req.query.usd);
  const currency = String(req.query.currency || "USD").toUpperCase();
  if (!Number.isFinite(usd)) return res.status(400).json({ error: "usd must be a number" });
  if (!SUPPORTED.includes(currency)) {
    return res.json({ value: usd, currency: "USD", rate: 1, available: false, supported: SUPPORTED });
  }
  // `convert` answers with a usable USD fallback when the rate is unavailable,
  // because showing nothing would be worse than showing the original amount.
  res.json((await convert(usd, currency)) ?? { value: usd, currency: "USD", rate: 1, available: false });
}));


/** Device-scoped router (mounted behind requireDevice). */
export const deviceRouter = Router();

// watchlist CRUD
deviceRouter.get("/watchlist", ah(async (req, res) => {
  res.json(await listCollection("watchlist", req.deviceId, "created_at.asc"));
}));

deviceRouter.post("/watchlist", ah(async (req, res) => {
  const { symbol, name, token_id, chain, source, address, pair_address, dex } = req.body || {};
  if (!symbol) return res.status(400).json({ error: "symbol required" });
  // The same ticker can exist on several chains, so identity is chain + symbol
  // rather than symbol alone.
  const sym = String(symbol).toUpperCase();
  const chainId = chain || null;
  const existing = await listCollection("watchlist", req.deviceId, "created_at.asc");
  if (existing.some((w) => w.symbol === sym && (w.chain ?? null) === chainId)) {
    return res.status(409).json({ error: "That coin is already in your list." });
  }
  const row = await insertRow("watchlist", {
    device_id: req.deviceId,
    symbol: sym,
    name: name || sym,
    // The contract address is what makes a DEX token unambiguous, and what
    // the DefiLlama price cross-check needs.
    address: address || null,
    pair_address: pair_address || null,
    dex: dex || null,
    token_id: token_id || null,
    chain: chainId,
    source: source || "dexscreener",
  });
  runOnce(req.deviceId).catch(() => {}); // immediate first tick
  res.status(201).json(row);
}));

deviceRouter.delete("/watchlist/:symbol", ah(async (req, res) => {
  const matcher = { symbol: req.params.symbol.toUpperCase() };
  // If a chain was given, only that specific coin is removed; otherwise the
  // first match for the ticker is, which is what the UI's star button does.
  if (req.query.chain) matcher.chain = req.query.chain;
  const ok = await deleteRow("watchlist", req.deviceId, matcher);
  res.json({ removed: ok });
}));

// manual poll (throttled) — auto-poll runs server-side every 30s regardless
deviceRouter.post("/watchlist/refresh", ah(async (req, res) => {
  const r = manualRefresh(req.deviceId);
  if (r.throttled) {
    return res.status(429).json({
      error: "We just checked. Give it a few seconds and we'll check again.",
      retry_in_ms: r.retry_in_ms,
    });
  }
  res.json({ refreshed: true, tokens: (await r.promise).length });
}));

// research + signals
deviceRouter.post("/research", ah(async (req, res) => {
  const { symbol, chain, address, name } = req.body || {};
  if (!symbol) return res.status(400).json({ error: "symbol required" });
  // Same snapshot path the poller uses, so a tip asked for on demand is
  // identical to the one that arrives automatically 30 seconds later.
  const snapshot = await marketSnapshot({ symbol, chain, address, name });
  if (!snapshot) return res.status(404).json({ error: "We couldn't find that coin's price." });
  const note = await research(await crossCheck(snapshot));
  await insertRow("research_logs", {
    device_id: req.deviceId, token: note.token.symbol, data_json: note,
    signal: note.prediction.signal, confidence: note.prediction.confidence,
  });
  res.json(note);
}));

deviceRouter.get("/signals", ah(async (req, res) => {
  const logs = await listCollection("research_logs", req.deviceId, "created_at.desc");
  res.json(logs.slice(0, 60));
}));

// The live paper-trading record for this device — how the AI's calls have
// actually performed on real prices since it started watching.
deviceRouter.get("/paper", ah(async (req, res) => {
  res.json({ model: modelInfo(), ...(await paperStats(req.deviceId)) });
}));


// How the models are progressing: the champion in use, the challengers being
// evaluated against it, and what the last improvement cycle actually did.
//
// This is deliberately public and read-only. Showing users the real ranking —
// including that a candidate was rejected — is the honest way to present a
// system that retrains itself.
publicRouter.get("/improvement", ah(async (_req, res) => {
  res.json({ model: modelInfo(), ...(await improvementReport()) });
}));

/**
 * Is the learning loop actually working?
 *
 * The improvement report says what the models are; this says whether the loop
 * that produces them is alive. The distinction matters when the app runs
 * unattended for a week: a dashboard can look healthy while the poller has
 * silently stopped, and nothing would be learned at all.
 *
 * The four numbers that answer that question:
 *   - daysObserved   how long this deployment has been accumulating evidence
 *   - settledCalls   rows the retrainer can actually learn from
 *   - openCalls      predictions still in flight
 *   - cycles         improvement cycles run, and whether they did anything
 *
 * `onTrack` is deliberately conservative: it requires real elapsed days *and*
 * enough settled calls to retrain on. Anything less is not yet evidence that
 * the loop works, however healthy the individual counters look.
 */
publicRouter.get("/improvement/progress", ah(async (_req, res) => {
  res.json(await learningProgress());
}));

/**
 * The model scoreboard — every model's live record, ranked.
 *
 * Separate from `/api/improvement`, which describes the champion/challenger
 * registry. Those models share one feature space and are compared on the same
 * calls; the board covers models that do not (the ensemble forecasts price
 * paths and emits no features), so it can only rank them on outcomes.
 *
 * `edge` is the number to read: Brier against a coin flip, signed. A negative
 * edge means the model is worse than guessing, and it stays off the trading
 * path no matter how confident its calls look.
 */
publicRouter.get("/models/board", ah(async (_req, res) => {
  res.json(board());
}));

/**
 * The auto-executor and live-trading readiness.
 *
 * These live on the authenticated router, not the public one, because both act
 * on behalf of a specific device: the sweep trades that device's watchlist
 * under that device's settings, and readiness is that device's checklist. The
 * read-only chain status is public, since it describes the app's configuration
 * rather than anyone's account.
 */
publicRouter.get("/autoexec", (_req, res) => {
  res.json(autoexecStatus());
});

deviceRouter.post("/autoexec/run", ah(async (req, res) => {
  res.json(await runAutoExecutor(req.deviceId, { chains: req.body?.chains }));
}));

deviceRouter.get("/live/readiness", ah(async (req, res) => {
  res.json(await liveReadinessFor(req.deviceId));
}));

// Force a cycle now. Useful after seeding data or when debugging, and it still
// obeys every gate: a forced run can still only ever *propose* a challenger.
publicRouter.post("/improvement/run", ah(async (_req, res) => {
  res.json(await runImprovementCycle({ force: true }));
}));

// trades (paper by default)
deviceRouter.get("/trades", ah(async (req, res) => {
  res.json(await listCollection("orders", req.deviceId, "created_at.desc"));
}));

deviceRouter.post("/trades/execute", ah(async (req, res) => {
  const { symbol, signal, chain } = req.body || {};
  if (!symbol || !signal) return res.status(400).json({ error: "symbol and signal required" });
  const snapshot = await marketSnapshot({ symbol, chain });
  if (!snapshot?.price_usd) return res.status(404).json({ error: "We couldn't find that coin's price." });
  const settings = (await getSettings(req.deviceId)) || {};
  const plan = planOrder(
    snapshot,
    {
      signal,
      confidence: 1,
      target_price: null,
      stop_price: null,
      reason: "You placed this trade yourself",
      model: "placed-by-you",
    },
    settings,
  );
  if (!plan) return res.status(400).json({ error: "There's nothing to trade right now." });
  const order = await executeOrder(req.deviceId, plan);
  res.status(201).json(order);
}));

// settings / credentials (encrypted at rest, secrets never echoed back)
deviceRouter.get("/settings", ah(async (req, res) => {
  res.json(maskSettings(await getSettings(req.deviceId)));
}));

deviceRouter.put("/settings", ah(async (req, res) => {
  const incoming = req.body || {};
  const current = (await getSettings(req.deviceId)) || {};
  const next = { ...current };
  // `trading_mode` is deliberately NOT in this whitelist. It used to be, which
  // meant `PUT /settings {trading_mode: "live"}` wrote the mode straight to
  // storage and skipped `liveReadiness()` entirely — the one-way, hard-to-undo
  // decision that `setTradingMode()` exists to guard was reachable by one
  // unguarded write. A confirmation dialog in the UI does not close that hole,
  // because the endpoint is the trust boundary and any client can call it
  // directly. The dedicated route below is now the only way to go live.
  for (const k of ["autopilot", "poll_interval_ms", "max_order_usd", "auto_trade_min_confidence", "wallet_address", "wallet_chain", "exchange_id", "trade_authority", "custody"]) {
    if (incoming[k] !== undefined) next[k] = incoming[k];
  }
  // A request that *tried* to switch modes gets a 409 pointing at the guarded
  // path, rather than silently ignoring the intent and reporting success.
  if (incoming.trading_mode !== undefined && incoming.trading_mode !== current.trading_mode) {
    return res.status(409).json({
      error: "trading_mode cannot be changed via settings",
      hint: "POST /api/devices/:id/trading-mode with { mode, confirm: true } instead",
      current: current.trading_mode ?? "paper",
    });
  }

  /**
   * Venue credentials, stored per-exchange under `exchanges[id]`.
   *
   * This used to be a flat whitelist of `binance_api_key` / `coinbase_api_key`
   * fields, which was a silent, total failure: `readCredentials()` has always read
   * `settings.exchanges[exchangeId]`, so every key typed into the UI was written to
   * a field nobody read and never reached an exchange. The UI showed a saved key,
   * and no order could ever have been placed with it. Any user who connected a
   * venue through Settings had a connected-looking UI and a trading app that could
   * not trade.
   *
   * Accepting a venue-keyed object instead of a per-venue field list is what makes
   * "connect whichever exchanges you like" possible at all: one shape covers every
   * venue `SUPPORTED_EXCHANGES` names, present and future, without a code change
   * per exchange.
   *
   * Merged field-by-field rather than replaced, so saving one venue's key does not
   * wipe another's. A field sent as `null` or an empty string is treated as absent
   * — never as "delete this venue", because a masked round trip (the API returns
   * `"••••saved"`) would otherwise wipe every key on any unrelated settings save.
   */
  const incomingExchanges = incoming.exchanges;
  if (incomingExchanges && typeof incomingExchanges === "object") {
    const existing = { ...(current.exchanges ?? {}) };
    for (const [id, creds] of Object.entries(incomingExchanges)) {
      if (!creds || typeof creds !== "object") continue;
      const prev = existing[id] ?? {};
      const clean = (v) => (typeof v === "string" && v && !v.startsWith("•") ? encryptSecret(v, req.deviceId) : undefined);
      const merged = {
        ...prev,
        apiKey: clean(creds.apiKey) ?? prev.apiKey,
        apiSecret: clean(creds.apiSecret) ?? prev.apiSecret,
        // OKX and some KuCoin configurations require a passphrase; Binance and
        // Coinbase reject one. Sent only when provided, never invented.
        passphrase: clean(creds.passphrase) ?? prev.passphrase,
      };
      // Only persist a venue that is actually usable. A half-filled form should
      // not leave a row that `liveReadiness()` counts as "connected".
      if (merged.apiKey && merged.apiSecret) existing[id] = merged;
    }
    next.exchanges = existing;
  }

  await putSettings(req.deviceId, next);
  res.json(maskSettings(next));
}));

/**
 * The risk slider. One control, three sectors.
 *
 * Returns the resolved profile alongside the new settings so the UI can render
 * the consequences immediately — every number the user is agreeing to — without a
 * second round trip and without the UI having to reimplement the mapping.
 */
deviceRouter.put("/risk", ah(async (req, res) => {
  const position = Number(req.body?.position);
  if (!Number.isFinite(position)) return res.status(400).json({ error: "position must be a number" });
  const { profile, settings } = await applyRiskProfile(req.deviceId, position);
  res.json({ profile, settings: maskSettings(settings), description: describeProfile(profile) });
}));

/**
 * What the app is currently allowed to do, resolved from the three settings.
 *
 * The UI needs this on load to render an accurate description without
 * reimplementing the resolution rules — and reimplementing them is how a client
 * ends up telling a user "you are in autonomous mode" for a combination the server
 * refuses to act on.
 */
deviceRouter.get("/capabilities", ah(async (req, res) => {
  const settings = (await getSettings(req.deviceId).catch(() => null)) ?? {};
  const caps = capabilities(settings);
  res.json({
    ...caps,
    description: describeCapabilities(caps),
    options: { trading_modes: TRADING_MODES, authorities: AUTHORITIES, custodies: CUSTODIES },
  });
}));
/**
 * Build an unsigned Solana swap transaction for the user's wallet to sign.
 *
 * This route deliberately returns a transaction and nothing more. It cannot sign,
 * cannot broadcast, and never receives a private key — the wallet extension does
 * that after the user approves it in their own UI. That boundary is what allows
 * the app to be given a token list without becoming a custodian.
 *
 * Requires assisted mode. In autonomous mode a wallet cannot sign at all (no
 * session keys yet), so a request here would produce a transaction nobody could
 * execute; refusing it is clearer than handing one over.
 */
deviceRouter.post("/wallet/swap", ah(async (req, res) => {
  const settings = (await getSettings(req.deviceId).catch(() => null)) ?? {};
  if (!capabilities(settings).isAssisted) {
    return res.status(409).json({ error: "wallet signing requires confirm-each-trade mode with wallet custody" });
  }
  const { inputMint, outputMint, amount, quote, slippageBps } = req.body || {};
  try {
    // A fresh quote is taken server-side rather than trusting a client-supplied
    // one: between the user's view and this call the price may have moved, and a
    // stale quote signed at a stale price is how a trade fills well away from what
    // was shown.
    const q = quote
      ? await quoteSwap({ inputMint, outputMint, amount, slippageBps })
      : await quoteSwap({ inputMint, outputMint, amount, slippageBps });
    if (!q.acceptable) {
      return res.status(422).json({ error: "route not viable", why: q.why, priceImpactBps: q.priceImpactBps });
    }
    const built = await buildSwapTransaction({ quote: q.quote, userPublicKey: settings.wallet_address });
    res.json({ quote: { inAmount: q.inAmount, outAmount: q.outAmount, priceImpactBps: q.priceImpactBps, routeHops: q.routeHops }, ...built });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

/**
 * Session-key issuance and revocation.
 *
 * The server holds the *session* key and its spend ledger, never the user's main
 * key. A request to open a session returns an unsigned approval instruction; the
 * user signs that in their wallet, and only then is the session usable.
 *
 * Note what is deliberately absent: no endpoint accepts a seed phrase, a private
 * key, or a main wallet secret. There is no shape of request this API will take
 * one, which is the property that makes it safe to point at real funds.
 */
deviceRouter.post("/session-key/open", ah(async (req, res) => {
  const settings = (await getSettings(req.deviceId).catch(() => null)) ?? {};
  const { payer, sessionPubkey } = req.body || {};
  try {
    const approval = buildSessionApproval({ payer, programs: req.body?.programs, authoritySeed: sessionPubkey });
    // Recorded as pending. It becomes usable only once the client reports a
    // signed approval, so an unsigned request cannot grant itself authority.
    await putSettings(req.deviceId, {
      ...settings,
      session_key: { status: "awaiting_signature", sessionPubkey, limits: SESSION_LIMITS, spentUsd: 0, createdAtMs: Date.now() },
    });
    res.json({ approval, limits: SESSION_LIMITS, remaining: sessionRemaining({ spentUsd: 0, createdAtMs: Date.now() }) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

/** Report that the user signed the approval, activating the session. */
deviceRouter.post("/session-key/confirmed", ah(async (req, res) => {
  const settings = (await getSettings(req.deviceId).catch(() => null)) ?? {};
  const existing = settings.session_key;
  if (!existing) return res.status(404).json({ error: "no session is open" });
  await putSettings(req.deviceId, {
    ...settings,
    session_key: { ...existing, status: "active", expiresAtBlock: req.body?.expiresAtBlock ?? existing.expiresAtBlock },
  });
  res.json({ ok: true, limits: SESSION_LIMITS });
}));

/** Revoke. Always permitted, including when something has gone wrong. */
deviceRouter.post("/session-key/revoke", ah(async (req, res) => {
  const settings = (await getSettings(req.deviceId).catch(() => null)) ?? {};
  const instruction = buildRevocation(settings.wallet_address);
  // Cleared locally first. A local session that still looks active after the user
  // asked to revoke it is the worst failure mode here, so local state is dropped
  // regardless of whether the on-chain instruction is later broadcast.
  await putSettings(req.deviceId, { ...settings, session_key: null });
  res.json({ ok: true, instruction });
}));

deviceRouter.get("/session-key", ah(async (req, res) => {
  const settings = (await getSettings(req.deviceId).catch(() => null)) ?? {};
  const session = settings.session_key ?? null;
  res.json({
    session: session ? { status: session.status, ...sessionRemaining(session) } : null,
    limits: SESSION_LIMITS,
    usable: sessionUsable(session).ok,
  });
}));



/**
 * Venues available to connect, so the UI never hardcodes a list.
 *
 * `needsPassphrase` is declared here rather than inferred in the UI because it is
 * a property of the venue's API, and the UI cannot know it. OKX always requires
 * one; KuCoin requires it on some account configurations. Sending an unnecessary
 * passphrase is harmless, omitting a required one is an auth failure, so the UI
 * must be told rather than guess.
 */
publicRouter.get("/exchanges", (_req, res) => {
  res.json({
    exchanges: SUPPORTED_EXCHANGES.map((e) => ({ ...e, needsPassphrase: PASSPHRASE_VENUES.has(e.id) })),
    default: config.exchangeId,
  });
});

/**
 * Proposals awaiting a signature. Assisted mode's inbox.
 *
 * Only live proposals by default. Expired and decided rows are excluded because
 * the common failure of a notification surface is showing a pile of stale
 * prompts, which trains the user to dismiss without reading — the exact habit
 * that makes assisted mode unsafe.
 */
deviceRouter.get("/proposals", ah(async (req, res) => {
  const all = await listCollection("proposals", req.deviceId);
  const includeAll = req.query.all === "true";
  const rows = all
    .filter((p) => (includeAll ? true : p.status === PROPOSAL_STATUS.PENDING && Date.parse(p.expires_at) > Date.now()))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  res.json({ proposals: rows, mode: describeCapabilities(capabilities((await getSettings(req.deviceId)) ?? {})) });
}));

/**
 * Decline a proposal.
 *
 * A first-class, recorded outcome — not a delete. Which signals a user declines
 * is genuine evidence about whether the app is proposing sensible things, and it
 * is only available if the decline is stored.
 */
deviceRouter.post("/proposals/:id/decline", ah(async (req, res) => {
  const rows = await listCollection("proposals", req.deviceId);
  const proposal = rows.find((p) => p.id === req.params.id);
  if (!proposal) return res.status(404).json({ error: "no such proposal" });
  if (!isLive(proposal)) return res.status(409).json({ error: "already decided or expired", status: proposal.status });
  await updateRow("proposals", proposal.id, {
    status: PROPOSAL_STATUS.DECLINED,
    decided_at: new Date().toISOString(),
    note: "declined by user",
  });
  res.json({ ok: true });
}));

/**
 * Record that a proposal was signed.
 *
 * The transaction itself was signed in the wallet and submitted by the client;
 * this endpoint records the outcome so the app's ledger matches what actually
 * happened on chain. It deliberately does **not** accept a signature from an
 * autonomous path — `trade_style === "assisted"` must hold, and the client is
 * expected to have obtained the signature from the user's wallet.
 *
 * No key material is accepted, stored, or forwarded by this route. It records an
 * identifier and a status.
 */
deviceRouter.post("/proposals/:id/signed", ah(async (req, res) => {
  const settings = (await getSettings(req.deviceId)) || {};
  if (!capabilities(settings).isAssisted) {
    return res.status(409).json({ error: "proposals are only used in assisted mode" });
  }
  const rows = await listCollection("proposals", req.deviceId);
  const proposal = rows.find((p) => p.id === req.params.id);
  if (!proposal) return res.status(404).json({ error: "no such proposal" });
  if (!isLive(proposal)) return res.status(409).json({ error: "already decided or expired", status: proposal.status });

  const { signature, venueOrderId = null, failed = false, note = null } = req.body || {};
  if (!signature || typeof signature !== "string") {
    return res.status(400).json({ error: "a signed transaction is required" });
  }
  const status = failed ? PROPOSAL_STATUS.FAILED : PROPOSAL_STATUS.EXECUTED;
  await updateRow("proposals", proposal.id, {
    status,
    signature,
    venue_order_id: venueOrderId,
    note: note ?? (failed ? "venue rejected the transaction" : "signed by user"),
    decided_at: new Date().toISOString(),
  });
  // Also booked as an order, so a completed trade becomes a first-class training
  // example via `normaliseOrders` — otherwise the one thing the app actually did
  // would be invisible to its own retrainer.
  await insertRow("orders", {
    device_id: req.deviceId,
    symbol: proposal.symbol,
    side: proposal.side,
    amount: proposal.amount,
    notional_usd: proposal.notional_usd,
    limit_price: proposal.limit_price,
    exchange_id: proposal.venue,
    model_basis: proposal.rationale?.model ?? null,
    probability: proposal.rationale?.prob_up ?? null,
    status: failed ? "live_failed" : "filled_live",
    filled_price: proposal.limit_price,
    venue_order_id: venueOrderId,
    note: note ?? "signed via assisted mode",
  });
  res.json({ ok: true, status });
}));

/**
 * The only route that may switch a device to live trading.
 *
 * Three things are required together, and each covers a different failure:
 *
 *   1. `mode: "live"` — the intent.
 *   2. `confirm: true` — the human acknowledgement. Enforced server-side so the
 *      confirmation cannot be bypassed by a client that renders no dialog, and
 *      so it is recorded in the request rather than assumed.
 *   3. Every `liveReadiness()` check passing — model promoted, breaker closed,
 *      an exchange connected, risk limits set.
 *
 * Failure returns the full check list rather than a bare false, so the UI can
 * show what is missing instead of "could not go live".
 */
deviceRouter.post("/trading-mode", ah(async (req, res) => {
  const { mode, confirm } = req.body || {};
  if (mode === "live" && confirm !== true) {
    return res.status(400).json({
      error: "confirmation required",
      hint: "switching to live places real orders with real money; resend with { mode: 'live', confirm: true }",
    });
  }
  const result = await setTradingMode(req.deviceId, mode);
  if (!result.ok) return res.status(409).json(result);
  await putSettings(req.deviceId, { ...(await getSettings(req.deviceId)), trading_mode: mode });
  res.json(result);
}));

function maskSettings(s) {
  if (!s) return {};
  const out = { ...s };
  for (const k of Object.keys(out)) {
    if (k.endsWith("_api_key") || k.endsWith("_api_secret")) out[k] = out[k] ? "••••saved" : null;
  }
    // Venue-keyed credentials. Masked by shape rather than by field name, so a new
    // venue needs no change here and no new secret can appear unmasked.
    // `has*` booleans let the UI show which venues are connected without
    // revealing anything: a client can render "connected" but can never read
    // the value back.
    if (out.exchanges && typeof out.exchanges === "object") {
      const masked = {};
      for (const [id, creds] of Object.entries(out.exchanges)) {
        if (!creds || typeof creds !== "object") continue;
        masked[id] = {
          hasKey: Boolean(creds.apiKey),
          hasSecret: Boolean(creds.apiSecret),
          hasPassphrase: Boolean(creds.passphrase),
        };
      }
      out.exchanges = masked;
    }
  return out;
}
