/**
 * Swap quoting for Solana, via Jupiter.
 *
 * The venue the app screens is Solana long-tail, aggregated through DexScreener.
 * DexScreener is a *price* source, not an execution source — it has no route and
 * no transaction. So a trade cannot be placed from it; it tells us what a token is
 * worth, and Jupiter is what turns that into a transaction a wallet can sign.
 *
 * Scope, stated plainly. This module builds quotes and *unsigned* swap
 * transactions. It never signs and never holds a key. That is not a limitation
 * bolted on afterwards — it is the correct boundary, and it is why the server can
 * be given a user's token list without becoming a custodian.
 *
 * The chain matters here. Solana has had native session keys for years: a
 * disposable keypair with on-chain program-scoped permissions that can be revoked.
 * That is what would eventually make unattended *wallet* trading possible, and it
 * is a much smaller lift than an ERC-4337 smart account. It is not built yet, and
 * building it before there is a strategy worth executing unattended would be
 * solving the signing problem for a system that has not solved the trading one.
 */

import { getJSON } from "../core/http.js";

/** Jupiter's public API. No key required for quotes. */
const JUP = "https://quote-api.jup.ag/v6";
const JUP_SWAP = "https://quote-api.jup.ag/v6/swap";

/** Mint addresses. Wrapped SOL rather than native SOL, which is what routes use. */
export const MINTS = {
  SOL: "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
};

/**
 * Slippage ceiling for a quote.
 *
 * Defaults tight and deliberately so. On a long-tail token the route may cross a
 * thin pool, and a wide slippage tolerance is how a "filled" swap ends up
 * materially below the quoted price — the trade reports as executed while losing
 * the edge it was placed for. 50bps (0.5%) is about the most a liquid pair can
 * absorb; anything deeper should be a deliberate per-trade decision, not a default.
 */
export const DEFAULT_SLIPPAGE_BPS = 50;

/** Reject a quote whose own price impact eats the trade. */
const MAX_PRICE_IMPACT_BPS = 300;

function toBps(fraction) {
  return Number((Number(fraction) * 10_000).toFixed(2));
}

/**
 * Quote a swap.
 *
 * `inputMint` is the token being sold and `outputMint` the one being bought. For a
 * BUY the input is the quote currency (USDC); for a SELL it is the token itself.
 *
 * Returns the quote plus a flat `acceptable` verdict. The caller proposes only if
 * it is true — a quote is not a trade, and this is where the cost wall is
 * enforced against the real route rather than an estimated volatility figure.
 */
export async function quoteSwap({
  inputMint,
  outputMint,
  amount,
  slippageBps = DEFAULT_SLIPPAGE_BPS,
  getJson = getJSON,
}) {
  if (!inputMint || !outputMint) throw new Error("quoteSwap needs both mints");
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) throw new Error("amount must be a positive number");

  const url =
    `${JUP}/quote?inputMint=${inputMint}&outputMint=${outputMint}` +
    `&amount=${Math.floor(amt)}&slippageBps=${slippageBps}&restrictIntermediateTokens=true`;

  const q = await getJson(url);
  const impactBps = toBps(q.priceImpactPct ?? 0);
  // Jupiter reports the price already, but `outAmount` vs `inAmount` is the
  // figure that decides whether this is worth doing, and comparing them keeps the
  // check independent of any single field being present.
  const out = Number(q.outAmount ?? 0);
  const inAmt = Number(q.inAmount ?? 0);
  const ratio = inAmt > 0 && out > 0 ? out / inAmt : null;

  return {
    quote: q,
    inputMint,
    outputMint,
    inAmount: inAmt,
    outAmount: out,
    priceImpactBps: impactBps,
    routeHops: (q.routePlan ?? []).length,
    slippageBps,
    /**
     * Whether this route is worth proposing at all.
     *
     * Depth, not direction, is the binding constraint on long-tail Solana: a thin
     * pool can quote a price the trade cannot actually reach. Refusing here means
     * the user is never asked to sign something that was never viable.
     */
    acceptable: impactBps <= MAX_PRICE_IMPACT_BPS && ratio !== null && ratio > 0,
    why:
      impactBps > MAX_PRICE_IMPACT_BPS
        ? `price impact ${impactBps}bps is too deep to trade`
        : "route is viable",
  };
}

/**
 * Build an unsigned swap transaction for a quote.
 *
 * The returned `swapTransaction` is a base64 blob the user's wallet signs. The
 * server never decodes or handles a private key, and never calls the endpoint
 * that would broadcast on the user's behalf — the wallet does that after they
 * approve it in their own extension.
 */
export async function buildSwapTransaction({ quote, userPublicKey, getJson = getJSON }) {
  if (!userPublicKey) throw new Error("a wallet public key is required");
  const body = {
    quoteResponse: quote,
    userPublicKey,
    // Dynamic compute unit limits: the wallet estimates what the swap actually
    // needs. A fixed limit either wastes SOL on gas or fails on a large route.
    dynamicComputeUnitLimit: true,
    skipUserAccountsRpcCalls: true,
  };
  const res = await getJson(`${JUP_SWAP}`, { method: "POST", body });
  if (!res?.swapTransaction) throw new Error("Jupiter returned no transaction to sign");
  return {
    transaction: res.swapTransaction,
    lastValidBlockHeight: res.lastValidBlockHeight ?? null,
    /**
     * Deliberately absent: any private key, signer or ability to broadcast. If
     * this object can be signed by the server, it should not exist.
     */
    requiresUserSignature: true,
  };
}

/** Pick the right input currency for a side. */
export function inputMintFor(side, tokenMint, quoteMint = MINTS.USDC) {
  // A BUY spends quote currency to acquire the token; a SELL spends the token.
  return side === "SELL" ? tokenMint : quoteMint;
}
