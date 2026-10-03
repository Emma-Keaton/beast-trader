/**
 * Exchange connectivity via CCXT.
 *
 * CCXT (56MB, 104 exchanges) is the one heavyweight dependency in this app, and
 * it earns its place: hand-rolling HMAC signing, nonce management, rate-limit
 * handling, and per-exchange order formats for 100 venues is where real systems
 * quietly lose money. Its own docs describe a long history of signature bugs in
 * naive implementations.
 *
 * Loaded lazily, on first use. A 56MB import on boot would slow every cold start
 * and would be paid even by users who never trade, so `getExchange()` is the
 * only path that touches the module.
 *
 * ── The rule that governs this whole file ─────────────────────────────────
 * This module can **place** orders. It can never **withdraw**. There is no
 * withdrawal method here, no withdrawal path, and no code path that could be
 * coaxed into one. That is a deliberate design constraint, not an oversight:
 * withdrawal is a different operation from trading with entirely different
 * consequences, and no amount of UI polish changes the fact that a compromised
 * trading key can be drained if it can also withdraw. We recommend — and the
 * safety checklist requires — that users create API keys with withdrawals
 * disabled entirely.
 *
 * Credentials never appear in a log, an error message, or an API response. They
 * are read from the device's encrypted settings at call time and are not cached
 * beyond the lifetime of a single request.
 */

import { config } from "../config.js";
import { getSettings, decryptSecret } from "../store.js";

/** Venues we expose. A shortlist beats CCXT's full list on purpose. */
export const SUPPORTED_EXCHANGES = [
  { id: "binance", label: "Binance", note: "Largest liquidity. Not available in some regions." },
  { id: "bybit", label: "Bybit", note: "Good liquidity, widely accessible." },
  { id: "coinbase", label: "Coinbase", note: "Strong for US and EU users." },
  { id: "kraken", label: "Kraken", note: "Long-standing, available in many regions." },
  { id: "kucoin", label: "KuCoin", note: "Wide token coverage." },
  { id: "okx", label: "OKX", note: "Good derivatives and spot." },
];

let ccxtModule = null;

/** Import CCXT on first use, never at boot. */
async function loadCcxt() {
  if (ccxtModule) return ccxtModule;
  try {
    const mod = await import("ccxt");
    ccxtModule = mod.default ?? mod;
    return ccxtModule;
  } catch (err) {
    throw new Error(`CCXT is not available: ${err.message}`);
  }
}

function isSupported(id) {
  return SUPPORTED_EXCHANGES.some((e) => e.id === id);
}

/**
 * Read a device's stored credentials for one exchange and decrypt them.
 *
 * Returns a shape CCXT accepts directly, or null when the user has not
 * connected this venue. Never throws on missing credentials — that is a normal
 * state, not an error, and callers branch on it.
 */
export async function readCredentials(deviceId, exchangeId) {
  const settings = await getSettings(deviceId);
  const stored = settings?.exchanges?.[exchangeId];
  if (!stored?.apiKey || !stored?.apiSecret) return null;

  const apiKey = decryptSecret(stored.apiKey, deviceId);
  const apiSecret = decryptSecret(stored.apiSecret, deviceId);
  if (!apiKey || !apiSecret) return null;

  const creds = { apiKey, secret: apiSecret };
  // A passphrase is required by a few venues (OKX, KuCoin in some configs) and
  // rejected by others, so it is only passed when actually stored.
  if (stored.passphrase) {
    const p = decryptSecret(stored.passphrase, deviceId);
    if (p) creds.password = p;
  }
  return creds;
}

/**
 * Build a CCXT client for an exchange.
 *
 * Public by default: with no credentials it can read markets but cannot trade.
 * That is what lets the market-data paths use the same code path as trading
 * without any risk of an unauthenticated call.
 *
 * @param opts `{ apiKey, secret, password, testnet, timeoutMs }`
 */
export async function getExchange(exchangeId, opts = {}) {
  if (!isSupported(exchangeId)) {
    throw new Error(`${exchangeId} is not a supported exchange`);
  }
  const ccxt = await loadCcxt();
  if (typeof ccxt[exchangeId] !== "function") {
    throw new Error(`CCXT has no client for ${exchangeId}`);
  }
  return new ccxt[exchangeId]({
    apiKey: opts.apiKey,
    secret: opts.secret,
    password: opts.password,
    // The network comes from config, not from an implicit default.
    //
    // This used to be `opts.testnet !== false`, which meant *absent* testnet
    // implied sandbox — so any caller that did not explicitly pass `testnet:
    // false` traded against a sandbox while the app believed it was on mainnet.
    // An implicit default is the wrong shape for this: the caller should not
    // have to know that omitting a flag changes where money moves.
    options: {
      defaultType: "spot",
      sandbox: opts.testnet !== undefined ? Boolean(opts.testnet) : config.network === "testnet",
    },
    timeout: opts.timeoutMs ?? 10_000,
    enableRateLimit: true,
  });
}

/**
 * Check that credentials actually work, without trading anything.
 *
 * `fetchBalance` is a read-only authenticated call. It is the only safe way to
 * verify a key: a "test order" would place a real order on a venue without a
 * sandbox, which is exactly what a user testing their setup does not expect.
 */
export async function verifyConnection(deviceId, exchangeId) {
  const creds = await readCredentials(deviceId, exchangeId);
  if (!creds) {
    return { ok: false, reason: "no credentials stored for this exchange" };
  }
  // Follows config rather than forcing a sandbox. Forcing testnet here meant a
  // user with mainnet credentials had them verified against a sandbox, which
  // fails — a production API key does not authenticate on the testnet URL. The
  // check has to target the network the user actually trades on.
  const ex = await getExchange(exchangeId, { ...creds, testnet: config.network === "testnet" });
  try {
    const bal = await ex.fetchBalance();
    return {
      ok: true,
      exchange: exchangeId,
      // Asset names only. Never amounts, never the key, never a signature — a
      // balance check only needs to prove the key authenticates.
      assets: Object.keys(bal?.total ?? {}).filter((a) => Number(bal.total[a]) !== 0),
      sandbox: Boolean(ex.options?.sandbox),
    };
  } catch (err) {
    // CCXT errors are the most useful diagnostic available and are safe to
    // surface: they describe authentication and permission failures, never the
    // key itself.
    return { ok: false, reason: err.message ?? "connection failed" };
  }
}

/**
 * Place a real order on a connected exchange.
 *
 * Called only by the trade gate, and only after every prerequisite has passed.
 * The order of checks below is deliberate:
 *
 *   1. **Refuse without an explicit opt-in.** `allowLive` is passed by the gate,
 *      which sets it only when the device has separately confirmed live mode.
 *   2. **Refuse without stored credentials.** A missing key is the most common
 *      cause of a live order failing halfway, and a half-failed order is worse
 *      than a clean refusal.
 *   3. **Refuse if the circuit breaker is open.** Manual orders go through the
 *      kill switch too, otherwise the kill switch has a hole in it.
 *   4. **Normalise the symbol.** Most venue-specific failures are really
 *      symbol-format failures, and catching it here gives a clear error instead
 *      of an exchange-side rejection.
 *   5. **Apply the venue's precision and limit filters** before sending.
 *      Rounding to the venue's step size is free; a rejected order costs time
 *      and can leave a partial fill.
 *
 * Market orders carry real slippage risk on thin pairs, so the default is a
 * limit order with a bounded price. A market order needs an explicit flag.
 */
export async function placeOrder(deviceId, exchangeId, order, opts = {}) {
  if (!opts.allowLive) {
    return { ok: false, status: "refused", reason: "live trading is not enabled for this device" };
  }
  if (!isSupported(exchangeId)) {
    return { ok: false, status: "refused", reason: `${exchangeId} is not a supported exchange` };
  }
  if (!opts.breakerCanTrade) {
    return { ok: false, status: "refused", reason: "trading is halted by the safety circuit breaker" };
  }

  const symbol = normaliseSymbol(order.symbol);
  if (!symbol) {
    return { ok: false, status: "refused", reason: `"${order.symbol}" is not a usable symbol` };
  }
  let amount = Number(order.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, status: "refused", reason: "amount must be a positive number" };
  }
  const type = order.type === "market" && opts.allowMarket ? "market" : "limit";
  // A limit order without a price is malformed and every venue would reject it.
  let price = type === "limit" ? Number(order.price) : null;
  if (type === "limit" && (!Number.isFinite(price) || price <= 0)) {
    return { ok: false, status: "refused", reason: "a limit order needs a price" };
  }

  const creds = await readCredentials(deviceId, exchangeId);
  if (!creds) {
    return { ok: false, status: "refused", reason: `no stored credentials for ${exchangeId}` };
  }

  const ex = await getExchange(exchangeId, { ...creds, testnet: opts.testnet ?? config.network === "testnet" });
  try {
    // Respect the venue's step size. Rounding *down* is deliberate: rounding up
    // could push the order past the user's risk cap by one step.
    if (typeof ex.amountToPrecision === "function") {
      amount = parseFloat(ex.amountToPrecision(symbol, amount)) || amount;
    }
    if (type === "limit" && typeof ex.priceToPrecision === "function") {
      price = parseFloat(ex.priceToPrecision(symbol, price)) || price;
    }

    const minCost = ex.market?.limits?.cost?.min;
    if (Number.isFinite(minCost) && type === "limit" && amount * price < minCost) {
      return { ok: false, status: "refused", reason: `order is below this exchange's minimum (${minCost})` };
    }

    const request = { symbol, type, side: order.side === "sell" ? "sell" : "buy", amount };
    if (type === "limit") request.price = price;

    const placed = await ex.createOrder(request);
    return {
      ok: true,
      status: placed?.status ?? "submitted",
      exchange: exchangeId,
      exchangeOrderId: placed?.id ?? null,
      symbol,
      side: request.side,
      type,
      amount: request.amount,
      price: request.price ?? placed?.price ?? null,
      fee: placed?.fee?.cost ?? null,
      feeCurrency: placed?.fee?.currency ?? null,
      timestamp: placed?.timestamp ?? Date.now(),
      // Stated explicitly: a user must never have to guess whether real funds
      // moved. Sandbox orders are simulations, full stop.
      simulated: Boolean(ex.options?.sandbox),
    };
  } catch (err) {
    return { ok: false, status: "failed", reason: err.message ?? "order failed" };
  }
}

/** Which assets are available on a connected exchange. Read-only. */
export async function fetchBalance(deviceId, exchangeId, opts = {}) {
  const creds = await readCredentials(deviceId, exchangeId);
  if (!creds) return { ok: false, reason: "no stored credentials" };
  const ex = await getExchange(exchangeId, { ...creds, testnet: opts.testnet ?? config.network === "testnet" });
  try {
    const bal = await ex.fetchBalance();
    return {
      ok: true,
      sandbox: Boolean(ex.options?.sandbox),
      // Asset names and amounts only. Never the API key, never a permissions
      // blob, and never a request signature.
      balances: Object.keys(bal?.total ?? {})
        .filter((a) => Number(bal.total[a]) !== 0)
        .map((asset) => ({ asset, free: Number(bal.free?.[asset] ?? 0), total: Number(bal.total[asset]) })),
    };
  } catch (err) {
    return { ok: false, reason: err.message ?? "balance fetch failed" };
  }
}

/** Read-only market ticker, used to sanity-check a symbol before trading. */
export async function fetchTicker(symbol) {
  const s = normaliseSymbol(symbol);
  if (!s) return null;
  // Never hardcoded to a sandbox. Testnet tickers cover a fraction of pairs and
  // quote different prices, so a sanity check against one would disagree with the
  // venue a real order would hit and quietly veto valid trades.
  const ex = await getExchange("binance", { testnet: config.network === "testnet" });
  try {
    const t = await ex.fetchTicker(s);
    return { symbol: s, last: t?.last ?? null, bid: t?.bid ?? null, ask: t?.ask ?? null };
  } catch {
    return null;
  }
}

/**
 * Normalise a symbol to CCXT's unified `BASE/QUOTE` form.
 *
 * Accepts the shapes the app actually produces — `BTCUSDT`, `BTC/USDT`,
 * `BTC-USDT` — and returns null rather than guessing when the quote currency is
 * genuinely ambiguous. Guessing would place an order on the wrong pair, which is
 * the single most expensive mistake this function could make.
 */
const KNOWN_QUOTES = ["USDT", "USDC", "BUSD", "FDUSD", "TUSD", "DAI", "USD", "BTC", "ETH", "EUR"];

export function normaliseSymbol(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const s = raw.trim().toUpperCase().replace(/[^A-Z0-9/]/g, "");
  if (!s) return null;
  if (s.includes("/")) {
    const [base, quote] = s.split("/");
    return base && quote ? `${base}/${quote}` : null;
  }
  // Longest quote first, so BTCUSDT is not misread as BTC/USD + "T".
  for (const q of KNOWN_QUOTES) {
    if (s.endsWith(q) && s.length > q.length) return `${s.slice(0, -q.length)}/${q}`;
  }
  return null;
}