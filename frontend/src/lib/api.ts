import { getOrCreateDeviceId } from "./device";

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) || "";
const TOKEN_KEY = "beast_jwt";

function token(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

/** Exchange the device id for a 30-day JWT (backend owns the secret). */
async function ensureSession(): Promise<string | null> {
  if (token()) return token();
  try {
    const res = await fetch(`${API_URL}/api/auth/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Device-ID": getOrCreateDeviceId() },
      body: JSON.stringify({ deviceId: getOrCreateDeviceId() }),
    });
    if (!res.ok) return null;
    const j = await res.json();
    localStorage.setItem(TOKEN_KEY, j.token);
    return j.token;
  } catch {
    return null;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  await ensureSession();
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-Device-ID": getOrCreateDeviceId(),
      ...(token() ? { Authorization: `Bearer ${token()}` } : {}),
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// ── API surface used by pages ─────────────────────────────
/**
 * A trade the app wants to make, waiting on the user's wallet signature.
 *
 * `rationale` is deliberately a nested object rather than loose fields: the UI has
 * to show the whole case for the trade together — what the model believes, how
 * much it thinks the move is worth, what it costs to act, and what is left — and a
 * flat shape invites rendering only the flattering part of it.
 */
export type Proposal = {
  id: string;
  symbol: string;
  side: "BUY" | "SELL";
  amount: number | null;
  notional_usd: number | null;
  limit_price: number | null;
  venue: string | null;
  /** Mint address. Required to route a swap; a ticker alone is ambiguous. */
  token_mint: string | null;
  chain: string | null;
  status: "pending_signature" | "executed" | "declined" | "failed" | "expired";
  created_at: string;
  expires_at: string;
  decided_at: string | null;
  note: string | null;
  rationale: {
    model: string | null;
    prob_up: number | null;
    confidence: number | null;
    expected_move: number | null;
    round_trip_cost_bps: number | null;
    edge_after_cost: number | null;
  };
};

export type ProposalInbox = { proposals: Proposal[]; mode: string };

/** One risk profile, as resolved by the server. */
export type RiskProfile = {
  position: number;
  sector: "conservative" | "balanced" | "aggressive";
  sectorLabel: string;
  withinSector: number;
  notionalScale: number;
  minConfidence: number;
  maxOrderUsd: number;
  maxDailyLossUsd: number;
  maxOpenPositions: number;
  minTrackDays: number;
  requiresProfitEvidence: boolean;
};

export type RiskResult = { profile: RiskProfile; settings: DeviceSettings; description: string };
/** How much authority the app has to move money without asking. */


/** The three orthogonal trading axes, resolved. */
export type Capabilities = {
  trading_mode: "paper" | "live";
  trade_authority: "auto" | "approve";
  custody: "cex_key" | "wallet";
  isPaper: boolean;
  isAutonomous: boolean;
  isAssisted: boolean;
  /** The only combination that can place an unattended order today. */
  canSignServerSide: boolean;
  description: string;
  options: { trading_modes: string[]; authorities: string[]; custodies: string[] };
};
export const api = {
  trending: () => request<Token[]>("/api/markets/trending"),
  movers: () => request<Token[]>("/api/markets/movers?limit=12"),
  chains: () => request<ChainVolume[]>("/api/markets/chains"),
  fx: () => request<FxRates>("/api/fx"),
  search: (q: string) => request<Token[]>(`/api/markets/search?q=${encodeURIComponent(q)}`),
  watchlist: () => request<WatchlistItem[]>("/api/watchlist"),
  star: (t: Partial<Token> & { symbol: string }) =>
    request("/api/watchlist", { method: "POST", body: JSON.stringify(t) }),
  unstar: (symbol: string, chain?: string) =>
    request(`/api/watchlist/${encodeURIComponent(symbol)}${chain ? `?chain=${encodeURIComponent(chain)}` : ""}`, { method: "DELETE" }),
  refresh: () => request("/api/watchlist/refresh", { method: "POST" }),
  research: (symbol: string, chain?: string) =>
    request<ResearchNote>("/api/research", { method: "POST", body: JSON.stringify({ symbol, chain }) }),
  signals: () => request<SignalLog[]>("/api/signals"),
  trades: () => request<Order[]>("/api/trades"),
  execute: (symbol: string, signal: string, chain?: string) =>
    request<Order>("/api/trades/execute", { method: "POST", body: JSON.stringify({ symbol, signal, chain }) }),
  settings: () => request<DeviceSettings>("/api/settings"),
  saveSettings: (s: Partial<DeviceSettings>) =>
    request<DeviceSettings>("/api/settings", { method: "PUT", body: JSON.stringify(s) }),
  /**
   * Switch paper <-> live.
   *
   * A dedicated route rather than a field on `saveSettings`, because going live
   * is the one irreversible decision in the app and it must not ride along with
   * an ordinary autosaving preferences save. `confirm` is required by the server
   * for `live`; the refusal to send it silently is deliberate friction.
   *
   * Goes to paper without confirmation — a user must never be locked out of
   * reducing their own risk.
   */
  setTradingMode: (mode: "paper" | "live", confirm = false) =>
    request<{ ok: boolean; mode: string; note?: string }>(`/api/trading-mode`, {
      method: "POST",
      body: JSON.stringify({ mode, confirm }),
    }),
  liveReadiness: () =>
    request<{
      ready: boolean;
      checks: { name: string; passed: boolean; detail: string }[];
      failures: { name: string; passed: boolean; detail: string }[];
      note: string;
    }>("/api/live/readiness"),
  /**
   * The risk slider. One control, three sectors.
   *
   * The server resolves the position and returns every resulting limit, so the
   * numbers shown next to the slider are the numbers actually enforced. The UI
   * never reimplements the mapping — a client-side copy would drift from the gate
   * and quietly tell the user something different from what is enforced.
   */
  /**
   * What the app is currently allowed to do, resolved server-side.
   *
   * The UI renders this description verbatim rather than deriving one from the
   * three settings itself — a client-side reimplementation is exactly how a screen
   * ends up claiming "unattended" for a combination the server refuses.
   */
  capabilities: () =>
    request<Capabilities>("/api/capabilities"),
  /**
   * Ask the server for an unsigned swap transaction to hand to the user's wallet.
   *
   * The response is a base64 blob and nothing else. There is no field in it that
   * could sign anything, which is why this route is safe to expose at all.
   */
  walletSwap: (body: { inputMint: string; outputMint: string; amount: number; slippageBps?: number }) =>
    request<{
      quote: { inAmount: number; outAmount: number; priceImpactBps: number; routeHops: number };
      transaction: string;
      lastValidBlockHeight: number | null;
      requiresUserSignature: true;
    }>("/api/wallet/swap", { method: "POST", body: JSON.stringify(body) }),
  risk: (position: number) =>
    request<RiskResult>("/api/risk", { method: "PUT", body: JSON.stringify({ position }) }),

  /**
   * Venues available to connect.
   *
   * Fetched rather than hardcoded. The list used to be four literal fields for two
   * exchanges in the Settings page, which silently capped the app at those two
   * while the backend supported six — and the mismatch was invisible until you
   * tried to connect a third.
   */
  exchanges: () =>
    request<{
      exchanges: { id: string; label: string; note?: string; needsPassphrase?: boolean }[];
      default: string;
    }>("/api/exchanges"),

  /** Trades waiting on a wallet signature. Live ones unless `all` is set. */
  proposals: (all = false) => request<ProposalInbox>(`/api/proposals${all ? "?all=true" : ""}`),
  declineProposal: (id: string) =>
    request<{ ok: boolean }>(`/api/proposals/${encodeURIComponent(id)}/decline`, { method: "POST" }),
  /** Records that the user signed in their wallet. Never carries key material. */
  recordSigned: (id: string, body: { signature: string; venueOrderId?: string; failed?: boolean; note?: string }) =>
    request<{ ok: boolean; status: string }>(`/api/proposals/${encodeURIComponent(id)}/signed`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  paper: () => request<PaperRecord>("/api/paper"),
  improvement: () => request<ImprovementReport>("/api/improvement"),
  runImprovement: () => request<ImprovementRun>("/api/improvement/run", { method: "POST" }),
};

/**
 * The state of the app's self-improvement loop.
 *
 * `challengers` is the live ranking of candidate models. A candidate appears
 * here whether it won or lost — the point is to show the work, not to hide it.
 */
export interface ImprovementReport {
  champion: { id: string | null; label: string; installedAt: string | null; provenance: string } | null;
  challengers: Array<{
    id: string;
    label: string;
    settled: number;
    expectancy: number | null;
    winRate: number | null;
    totalReturn?: number;
    eligible: boolean;
    /** Full stability report from the drawdown gate. */
    risk?: {
      ok: boolean;
      why: string;
      stats: { trades: number; maxDrawdown: number; profitFactor: number; lossCadence: number } | null;
    } | null;
  }>;
  /** The best challenger, with its loss profile flattened for display. */
  bestChallenger?: {
    label: string;
    settled: number;
    expectancy: number;
    ageDays: number | null;
    eligible: boolean;
    maxDrawdown: number | null;
    profitFactor: number | null;
    riskOk: boolean | null;
  } | null;
    riskWhy: string | null;
  rules: { minSettledCalls: number; minExpectancyEdge: number; maxChallengers: number; maxDrawdown?: number; minProfitFactor?: number; minLossCadence?: number; minTrackDays?: number };
  lastCycle: {
    at: string;
    trained: { ran: boolean; reason?: string; challenger?: string; trained_on?: number; held_out?: number; expectancy?: number };
    promoted: string | null;
    promotionReason: string | null;
  } | null;
}

export interface ImprovementRun {
  promotion: { promote: boolean; reason: string };
  trained: { ran: boolean; reason?: string; challenger?: string; trained_on?: number; expectancy?: number };
  promoted?: string;
}

export interface PaperRecord {
  model: {
    trained: boolean;
    promoted?: boolean;
    verdict?: { promoted: boolean; reasons: string[]; headline: string } | null;
    metrics?: {
      accuracy: number;
      brier: number;
      winRate: number;
      expectancy: number;
      trades: number;
      maxDrawdown: number;
    } | null;
  };
  open: number;
  settled: number;
  winRate: number | null;
  beatMarket: number | null;
  totalReturn: number;
  marketReturn: number;
  avgReturn: number | null;
}

// ── shared types ───────────────────────────────────────────
export interface Token {
  id?: string;
  symbol: string;
  name?: string;
  /** Contract address — what makes a DEX token unambiguous. */
  address?: string | null;
  token_id?: string | null;
  price_usd?: number | null;
  change_24h?: number | null;
  change_1h?: number | null;
  chain?: string | null;
  dex?: string;
  pair_address?: string;
  liquidity_usd?: number | null;
  volume_h24?: number | null;
  volume_6h?: number | null;
  buys_1h?: number | null;
  sells_1h?: number | null;
  icon?: string | null;
  url?: string;
  momentum?: number;
  source?: string;
}

export interface ChainVolume {
  chain: string;
  total24h: number | null;
  change_1d: number | null;
  dexCount: number;
}

export interface CacheStats {
  name: string;
  size: number;
  inFlight: number;
  hitRate: number | null;
}

export interface SourceHealth {
  host: string;
  state: "closed" | "open" | "half-open";
  failures: number;
}

export interface ModelInfo {
  trained: boolean;
  promoted?: boolean;
  name?: string;
  verdict?: { promoted: boolean; reasons: string[]; headline: string } | null;
  metrics?: Record<string, number> | null;
}

export interface WatchlistItem extends Token {
  token_id?: string | null;
  created_at?: string;
}

export interface Prediction {
  signal: "LONG" | "SHORT" | "HOLD";
  confidence: number;
  target_price: number | null;
  horizon: string;
  rationale: string;
  model: string;
}

export interface ResearchNote {
  token: { symbol: string; name: string; chain: string; source: string };
  market: { price_usd: number | null; change_24h: number | null; volume_h24: number | null; liquidity_usd: number | null };
  summary: string;
  prediction: Prediction;
  generated_at: string;
  engine: string;
}

export interface SignalLog {
  id: string;
  token: string;
  signal: string;
  confidence: number;
  data_json: ResearchNote;
  created_at: string;
}

export interface Order {
  id: string;
  symbol: string;
  side: string;
  qty: number;
  notional_usd: number;
  filled_price?: number;
  status: string;
  mode: string;
  venue?: string;
  chain?: string;
  rationale?: string;
  created_at: string;
}

export interface FxRates {
  available: boolean;
  /** Multiplier: display amount = usd amount * rates[currency]. */
  rates: Record<string, number>;
  updated: string | null;
  source: string;
  supported: string[];
}

export interface DeviceSettings {
  autopilot?: boolean;
  trading_mode?: "paper" | "live";
  max_order_usd?: number;
  auto_trade_min_confidence?: number;
  wallet_address?: string;
  wallet_chain?: string;
  /** Display currency. Display only — never affects stored prices or sizing. */
  currency?: string;
  /** How much authority the app has. Defaults to paper when unset. */
  trade_authority?: "auto" | "approve";
  custody?: "cex_key" | "wallet";
  /** Which venue live orders go to. Others may also be connected. */
  exchange_id?: string;
  /**
   * Connected venues, masked by the API as `{hasKey, hasSecret, hasPassphrase}`.
   * Never contains a secret: the client can render "connected" but cannot read a
   * key back, even one it just typed.
   */
  exchanges?: Record<string, { hasKey?: boolean; hasSecret?: boolean; hasPassphrase?: boolean }>;
}
