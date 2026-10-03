/**
 * Per-chain risk profiles.
 *
 * One CircuitBreaker for the whole app is not enough. A Solana memecoin
 * executor and a Bitcoin spot executor are not the same risk, and a losing day
 * in one says nothing about the other. With a single global breaker, the first
 * chain to trip halts every chain — which teaches the wrong lesson (that the
 * *system* is broken) when the truth is that one *strategy* on one venue of
 * long-tail tokens is broken.
 *
 * So each chain gets its own breaker. A Solana loss spiral stops Solana and
 * leaves the rest running, which is both safer (smaller blast radius) and more
 * useful (the surviving chains keep earning evidence).
 */

import { CircuitBreaker } from "./circuit.js";

/**
 * Risk profile per chain family.
 *
 * `minLiquidityUsd` is the single most important number here. It is the
 * difference between a stop-loss that can actually execute and one that is
 * decoration.
 */
export const CHAIN_PROFILES = {
  solana: { label: "Solana", kind: "dex", minLiquidityUsd: 100_000, maxNotionalUsd: 25, minConfidence: 0.75, maxDrawdown: 0.25, maxConsecutiveLosses: 4 },
  ethereum: { label: "Ethereum", kind: "dex", minLiquidityUsd: 500_000, maxNotionalUsd: 25, minConfidence: 0.78, maxDrawdown: 0.25, maxConsecutiveLosses: 4 },
  base: { label: "Base", kind: "dex", minLiquidityUsd: 150_000, maxNotionalUsd: 20, minConfidence: 0.75, maxDrawdown: 0.25, maxConsecutiveLosses: 4 },
  bsc: { label: "BNB Chain", kind: "dex", minLiquidityUsd: 200_000, maxNotionalUsd: 20, minConfidence: 0.75, maxDrawdown: 0.25, maxConsecutiveLosses: 4 },
  arbitrum: { label: "Arbitrum", kind: "dex", minLiquidityUsd: 150_000, maxNotionalUsd: 20, minConfidence: 0.75, maxDrawdown: 0.25, maxConsecutiveLosses: 4 },
  polygon: { label: "Polygon", kind: "dex", minLiquidityUsd: 150_000, maxNotionalUsd: 20, minConfidence: 0.75, maxDrawdown: 0.25, maxConsecutiveLosses: 4 },
  avalanche: { label: "Avalanche", kind: "dex", minLiquidityUsd: 120_000, maxNotionalUsd: 20, minConfidence: 0.75, maxDrawdown: 0.25, maxConsecutiveLosses: 4 },
  // Majors on a major exchange are a different risk class from a long-tail DEX
  // pair, so they get a looser profile. The same token at a different venue is
  // a different trade.
  cex: { label: "Major exchange (CEX)", kind: "cex", minLiquidityUsd: 500_000, maxNotionalUsd: 100, minConfidence: 0.65, maxDrawdown: 0.15, maxConsecutiveLosses: 6 },
};

/** Chains the auto-executor scans, in priority order. */
export const AUTO_CHAINS = ["cex", "solana", "base", "arbitrum", "bsc", "polygon", "ethereum", "avalanche"];

export function profileFor(chain) {
  const key = String(chain ?? "cex").toLowerCase();
  return CHAIN_PROFILES[key] ?? CHAIN_PROFILES.cex;
}

/** Per-chain breakers, created on first use. */
const breakers = new Map();

export function chainBreaker(chain) {
  const key = String(chain ?? "cex").toLowerCase();
  if (!breakers.has(key)) {
    const p = profileFor(key);
    breakers.set(
      key,
      new CircuitBreaker({ maxDrawdown: p.maxDrawdown, maxConsecutiveLosses: p.maxConsecutiveLosses }),
    );
  }
  return breakers.get(key);
}

/**
 * Why this candidate cannot be traded, or `{ ok: true }` if it can.
 *
 * Venue checks come *before* the confidence check, and that ordering is
 * deliberate. A model being 95% sure about a $4,000 pool is still wrong to
 * trade: confidence is about direction, and pool depth is about whether the
 * trade can be entered and exited at all. Checking liquidity first avoids
 * spending reasoning on candidates that were never viable.
 *
 * ── Why the DEX thresholds are so much stricter ────────────────────────────
 * They are not arbitrary caution. Long-tail DEX tokens carry risks a spot pair
 * on a major exchange does not:
 *
 *   - **Liquidity can vanish.** A $30k pool can be drained in one transaction,
 *     and by the time a stop-loss would have fired there is nothing left to sell.
 *   - **Slippage is unbounded when it matters.** The quoted price is the price
 *     for a tiny order. Yours is not a tiny order.
 *   - **The contract can be malicious** — a honeypot, a transfer tax, a mint
 *     function one wallet controls. None of that is visible in a price chart.
 *   - **There is no recourse.** A major exchange will reverse an erroneous fill
 *     or a stolen withdrawal. A DEX has no customer service.
 *
 * A confidence score measures one thing: how sure the model is about direction.
 * It says nothing about any of the above. So the floor is set by the venue, not
 * by the model, and a high-confidence signal on a thin pool is still refused.
 */
export function screenCandidate({ chain, snapshot, prediction, profile }) {
  const p = profile ?? profileFor(chain);
  const reasons = [];

  const liquidity = Number(snapshot?.liquidity_usd ?? 0);
  if (p.kind === "dex") {
    if (!(liquidity > 0)) {
      reasons.push("no liquidity figure available, so the size of the exit is unknown");
    } else if (liquidity < p.minLiquidityUsd) {
      reasons.push(
        `only $${Math.round(liquidity).toLocaleString()} of liquidity — below the ` +
          `$${p.minLiquidityUsd.toLocaleString()} needed to enter and exit safely`,
      );
    }
  }

  // A missing price is a venue-safety problem, not a model problem.
  if (!Number.isFinite(Number(snapshot?.price_usd)) || Number(snapshot.price_usd) <= 0) {
    reasons.push("no usable price");
  }

  if (prediction?.signal === "HOLD") reasons.push("no directional signal");
  if (!Number.isFinite(prediction?.confidence) || prediction.confidence < p.minConfidence) {
    reasons.push(
      `confidence ${(Number(prediction?.confidence ?? 0) * 100).toFixed(0)}% is below the ` +
        `${(p.minConfidence * 100).toFixed(0)}% required on ${p.label}`,
    );
  }

  return { ok: reasons.length === 0, reasons, profile: p };
}

/** Status of every chain's breaker, for the dashboard. */
export function allChainStatus() {
  return AUTO_CHAINS.map((chain) => {
    const b = chainBreaker(chain);
    const p = profileFor(chain);
    return {
      chain,
      label: p.label,
      kind: p.kind,
      canTrade: b.canTrade(),
      state: b.state,
      reason: b.reason,
      drawdown: b.status().drawdown,
      consecutiveLosses: b.consecutiveLosses,
      limits: {
        maxDrawdown: p.maxDrawdown,
        maxConsecutiveLosses: p.maxConsecutiveLosses,
        maxNotionalUsd: p.maxNotionalUsd,
        minConfidence: p.minConfidence,
        minLiquidityUsd: p.minLiquidityUsd,
      },
    };
  });
}

/** Test seam. */
export function resetChainBreakers() {
  breakers.clear();
}