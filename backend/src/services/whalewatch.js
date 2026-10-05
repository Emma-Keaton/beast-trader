/**
 * Whale flow collector (Helius).
 *
 * Watches the token mints this app already knows about and records *large*
 * wallet movements of those tokens into `whale_flows` — plain transfers above
 * a USD floor and swaps whose initiator moved more than the floor. These are
 * the discrete "a significant wallet did something" events that
 * `dex_snapshots`' periodic pool readings can never show: exchange deposits
 * and withdrawals, OTC blocks, treasury moves.
 *
 * The same two rules the DEX collector follows apply here verbatim:
 *
 * 1. **Observations only, never a trade trigger.** Nothing here decides to
 *    trade. The promotion gate stays the only path from evidence to a model
 *    that is allowed to place orders.
 *
 * 2. **Quota-bounded, degrading rather than failing.** Every Helius call
 *    spends a rate-window slot and 10 credits of the monthly allowance
 *    through `quota.js`; every price lookup spends a DexScreener slot. When a
 *    budget is exhausted the mint is skipped for this tick instead of
 *    hammering the provider — a sparser flow history still trains, a
 *    suspended key costs a month.
 *
 * And one rule specific to this collector:
 *
 * 3. **Disabled without a key, loudly about it.** No `HELIUS_API_KEY` means
 *    the tick returns `{ enabled: false }` without touching the network. The
 *    app must be fully functional in that state — flows are additive
 *    training material, not a dependency.
 *
 * Known limitations, stated rather than hidden:
 *
 * - The transaction-history endpoint returns txs where the address appears in
 *   the account keys. `TransferChecked` and swap instructions include the
 *   mint, so this covers the common cases; an exotic transfer that never
 *   references the mint account is invisible to it. `scripts/probe-whale.js`
 *   prints what a live run actually sees, so this is measurable rather than
 *   assumed.
 * - USD values come from a DexScreener price sampled at collection time. A
 *   volatile minute can mis-size a flow by a few percent; the raw token
 *   amount is stored alongside so it can be recomputed.
 * - `whale_profiles` is NOT maintained yet. The schema anticipates a
 *   per-wallet rollup, but `store.js` has no key-conflict-safe upsert for its
 *   wallet-primary-key table, and a rollup is only useful once a feature
 *   actually consumes it. Flows — the raw material — are collected now; the
 *   rollup is a deliberate follow-up, not an accident.
 *
 * Pure parsing (`parseWhaleFlows`) is exported separately from fetching for
 * the same reason as in `dexwatch.js`: a provider payload change must show up
 * as a failing test, not as empty tables three days later.
 */

import { config } from "../config.js";
// The shared rate windows, under an explicit API-facing name so this module's
// binding can never collide with — or be shadowed by — a local `budgets`
// declaration added later.
import { budgets as apiBudgets } from "./dexwatch.js";
import { insertRows, listAllRows } from "../store.js";
import { MINTS } from "./solana.js";

const HELIUS_BASE = "https://api.helius.xyz";
const DEX_BASE = "https://api.dexscreener.com";
const DEFAULT_TIMEOUT_MS = 8000;

/** Smallest movement worth a row. Below this it is ordinary wallet noise. */
export const MIN_WHALE_USD = 50_000;

/** Transactions fetched per mint per tick (the endpoint's maximum). */
export const WHALE_TX_LIMIT = 100;

/**
 * Credits charged to the local tracker per enhanced-transaction call.
 *
 * Helius prices standard REST calls at 10 credits against the 1,000,000
 * monthly allowance. Charging the conservative number is deliberate: an
 * over-charge throttles the collector slightly early; an under-charge
 * discovers the real cost by running out mid-month.
 */
const CREDITS_PER_CALL = 10;

/**
 * Mints to watch: `symbol -> mint address`.
 *
 * Defaults are the three mints this repo already ships (`solana.js` MINTS) —
 * wrapped SOL plus the two stables every Solana route quotes through. Override
 * with `WHALE_MINTS=SOL:<mint>,BONK:<mint>` to widen or narrow the set without
 * a code change.
 */
export function trackedMints(raw = process.env.WHALE_MINTS) {
  if (typeof raw === "string" && raw.includes(":")) {
    const out = {};
    for (const part of raw.split(",")) {
      const [sym, mint] = part.split(":").map((s) => s?.trim());
      if (sym && mint) out[sym.toUpperCase()] = mint;
    }
    if (Object.keys(out).length) return out;
  }
  return { ...MINTS };
}

/* ── fetching (network, budgeted) ─────────────────────────────────────────── */

/**
 * Rate-limited fetch. Returns null on any failure rather than throwing.
 * One bad symbol must never stop the tick — the caller skips and continues.
 */
async function fetchJson(url, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Recent transactions for one address (a mint, in this collector).
 * Returns an array, or null on failure so the tick can count it as denied.
 */
export async function fetchTransactions(address, { apiKey } = {}) {
  if (!apiKey) return null;
  const url =
    `${HELIUS_BASE}/v0/addresses/${encodeURIComponent(address)}/transactions` +
    `?api-key=${encodeURIComponent(apiKey)}&limit=${WHALE_TX_LIMIT}&commitment=confirmed`;
  const json = await fetchJson(url);
  return Array.isArray(json) ? json : null;
}

/**
 * USD price for a mint, from the deepest DexScreener pair. Null when the
 * budget is spent or no pair reports a price — the parser then skips sizing
 * that mint for this tick rather than inventing a number.
 */
export async function fetchTokenPriceUsd(mint, { symbol } = {}) {
  // Stables are the reference asset itself: quoting them through a pool would
  // spend a request to learn what $1 is.
  if (symbol === "USDC" || symbol === "USDT" || symbol === "USD") return 1;
  if (!apiBudgets.dexscreenerPairs.take()) return null;
  const json = await fetchJson(`${DEX_BASE}/latest/dex/tokens/${encodeURIComponent(mint)}`);
  const pairs = Array.isArray(json?.pairs) ? json.pairs : [];
  let best = null;
  for (const p of pairs) {
    const price = Number(p?.priceUsd);
    const liq = Number(p?.liquidity?.usd);
    if (!Number.isFinite(price) || price <= 0) continue;
    if (!best || liq > best.liq) best = { price, liq: Number.isFinite(liq) ? liq : 0 };
  }
  return best ? best.price : null;
}

/* ── parsing (pure) ───────────────────────────────────────────────────────── */

/**
 * Turn one enhanced transaction into zero or more `whale_flows` rows.
 *
 * Emits a row per token transfer of `mint` whose USD size clears `minUsd`:
 *
 *  - **Plain TRANSFER** → `side: "unknown"`. A wallet moving funds says
 *    nothing about direction of the market; claiming "buy" or "sell" from it
 *    would be invention. The *mover* (`fromUserOwner`) is the wallet.
 *  - **SWAP** → `side: "buy" | "sell"` relative to the fee payer (the wallet
 *    that initiated the swap): gaining the tracked token is a buy, paying it
 *    is a sell. The fee payer is the wallet of record.
 *
 * Returns [] rather than partial rows when the essentials (signature,
 * timestamp, priced size) are missing — a row with an unknown USD size
 * cannot be filtered by the threshold, and an unfiltered threshold is no
 * threshold at all.
 */
export function parseWhaleFlows(tx, { mint, symbol, priceUsd, chain = "solana", minUsd = MIN_WHALE_USD } = {}) {
  if (!tx || typeof tx !== "object") return [];
  if (typeof tx.signature !== "string" || !tx.signature) return [];
  if (!Array.isArray(tx.tokenTransfers) || !mint) return [];

  const tsSec = Number(tx.timestamp);
  if (!Number.isFinite(tsSec) || tsSec <= 0) return [];
  const ts = new Date(tsSec * 1000).toISOString();

  const price = Number(priceUsd);
  if (!Number.isFinite(price) || price <= 0) return []; // unsized flows are unusable

  const isSwap = tx.type === "SWAP" || Boolean(tx.events?.swap);
  const feePayer = typeof tx.feePayer === "string" ? tx.feePayer : null;

  const rows = [];
  for (const t of tx.tokenTransfers) {
    if (t?.mint !== mint) continue;
    const amount = uiAmount(t);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const usd = amount * price;
    if (!Number.isFinite(usd) || usd < minUsd) continue;

    const from = t.fromUserOwner ?? null;
    const to = t.toUserOwner ?? null;

    let wallet;
    let side;
    if (isSwap) {
      wallet = feePayer ?? from ?? to;
      if (feePayer && to === feePayer) side = "buy";
      else if (feePayer && from === feePayer) side = "sell";
      else side = "unknown";
    } else {
      wallet = from ?? feePayer ?? to;
      side = "unknown";
    }
    if (!wallet) continue;

    rows.push({
      wallet,
      symbol,
      chain,
      ts,
      side,
      amount_usd: Number(usd.toFixed(2)),
      token_amount: amount,
      tx_signature: tx.signature,
      // The full payload is kept so a mis-parsed row can be rebuilt later
      // without re-fetching — same reasoning as dex_snapshots.raw.
      raw: tx,
    });
  }
  return rows;
}

/** UI amount, with a raw-amount fallback for payloads that omit it. */
function uiAmount(t) {
  const ui = Number(t?.tokenAmount);
  if (Number.isFinite(ui) && ui > 0) return ui;
  const raw = Number(t?.rawTokenAmount?.tokenAmount);
  const decimals = Number(t?.rawTokenAmount?.decimals);
  if (Number.isFinite(raw) && Number.isFinite(decimals) && raw > 0) return raw / 10 ** decimals;
  return NaN;
}

/** Identity of a flow for de-duplication across ticks and restarts. */
export function flowKey(row) {
  return `${row.tx_signature}|${row.symbol}|${row.wallet}|${row.side}`;
}

/* ── collection ───────────────────────────────────────────────────────────── */

/**
 * Keys already stored. Fetching recent rows and inverting their keys beats
 * maintaining a parallel seen-set: dedup state survives restarts for free
 * and cannot drift from the table it describes.
 */
async function loadKnownKeys() {
  try {
    const rows = await listAllRows("whale_flows", "ts.desc", 3000);
    return new Set(rows.filter((r) => r?.tx_signature).map(flowKey));
  } catch {
    return new Set();
  }
}

/** Persist flows, tolerating a schema-shaped mismatch the way dexwatch does. */
async function persistFlows(rows) {
  try {
    return await insertRows("whale_flows", rows);
  } catch (err) {
    const msg = String(err?.message ?? err);
    if (msg.includes("column") || msg.includes("schema")) {
      console.warn(
        "[whalewatch] insert rejected — does whale_flows exist and match",
        "whalewatch.js? Run the supabase schema migration. Flows skipped:",
        rows.length,
        "|",
        msg
      );
      return 0;
    }
    throw err;
  }
}

/**
 * One collection pass over every tracked mint. Returns a counters object
 * (never throws) so callers and tests can assert on what happened:
 *
 * - `enabled: false` — no `HELIUS_API_KEY`; zero network calls were made.
 * - `fetched` — transactions returned by Helius across all mints.
 * - `stored` — genuinely new rows written this tick.
 * - `duplicates` — parsed rows whose flow key already existed (retries,
 *   overlapping windows across ticks).
 * - `budget_denied` — mints skipped because a rate/credit budget ran out.
 * - `prices_unavailable` — mints skipped because no USD price resolved;
 *   their flows are unsizable this tick.
 */
export async function collectOnce({
  mints = trackedMints(),
  apiKey = config.heliusApiKey,
  fetchTxs = fetchTransactions,
  priceFn = fetchTokenPriceUsd,
  persist = persistFlows,
  known = loadKnownKeys,
} = {}) {
  if (!apiKey) return { enabled: false, reason: "HELIUS_API_KEY not set", fetched: 0, stored: 0 };

  const knownSet = await known();
  const seen = new Set(); // in-batch dedup for overlapping mints / retries
  const result = {
    enabled: true,
    fetched: 0,
    parsed: 0,
    stored: 0,
    duplicates: 0,
    budget_denied: 0,
    prices_unavailable: 0,
  };
  const fresh = [];

  for (const [symbol, mint] of Object.entries(mints)) {
    if (!apiBudgets.heliusStandard.take() || !apiBudgets.credits.spend(CREDITS_PER_CALL)) {
      result.budget_denied += 1;
      continue;
    }
    const txs = await fetchTxs(mint, { apiKey });
    if (!Array.isArray(txs)) {
      result.budget_denied += 1; // provider error or rate limit — back off either way
      continue;
    }
    result.fetched += txs.length;

    const priceUsd = await priceFn(mint, { symbol });
    if (priceUsd == null) {
      result.prices_unavailable += 1;
      continue;
    }

    for (const tx of txs) {
      const rows = parseWhaleFlows(tx, { mint, symbol, priceUsd });
      result.parsed += rows.length;
      for (const row of rows) {
        const key = flowKey(row);
        if (knownSet.has(key) || seen.has(key)) {
          result.duplicates += 1;
          continue;
        }
        seen.add(key);
        fresh.push(row);
      }
    }
  }

  if (fresh.length) result.stored = await persist(fresh);
  return result;
}

/**
 * Log one tick, mirroring dexwatch.tick's shape: a single line while
 * disabled (not one per interval — months of "disabled" spam helps nobody),
 * counters once something is actually flowing.
 */
let loggedDisabled = false;
export async function tick() {
  const result = await collectOnce();
  if (!result.enabled) {
    if (!loggedDisabled) {
      console.log("[whalewatch] HELIUS_API_KEY not set — whale flow collection disabled (app runs normally)");
      loggedDisabled = true;
    }
    return result;
  }
  loggedDisabled = false;
  if (result.stored > 0 || result.budget_denied > 0 || result.prices_unavailable > 0) {
    console.log(
      `[whalewatch] fetched=${result.fetched} stored=${result.stored} dup=${result.duplicates}`,
      `denied=${result.budget_denied} no_price=${result.prices_unavailable}`
    );
  }
  return result;
}

/** Snapshot for health/status surfaces. Observational data only. */
export function whaleStatus() {
  return {
    enabled: Boolean(config.heliusApiKey),
    min_usd: MIN_WHALE_USD,
    mints: Object.keys(trackedMints()),
    credits_per_call: CREDITS_PER_CALL,
    table: "whale_flows",
    // Nothing in this module can place, size, or gate a trade.
    trade_trigger: false,
  };
}
