/**
 * The auto-executor.
 *
 * Watches each chain's top performers, and acts when a candidate clears that
 * chain's thresholds. Three properties make this safe to run unattended:
 *
 *  1. **It cannot place a live order by itself.** Everything operates in paper
 *     mode unless the device has independently passed the live-readiness gate
 *     *and* the per-order trade gate. No confidence score unlocks a shortcut.
 *  2. **Every decision is recorded, including refusals.** An executor you cannot
 *     audit is one you cannot trust. Each candidate produces a record of what
 *     was considered and why, so a quiet week is distinguishable from a broken
 *     one.
 *  3. **Venue risk is checked before model confidence** — see `screenCandidate`
 *     in `ml/chains.js` for why that ordering matters.
 *
 * Note on the path this replaces: `maybeAutoTrade` in `executor.js` called
 * `executeOrder` directly, bypassing the trade gate. It checked model promotion
 * and a confidence threshold, but not the circuit breaker, the per-order cap,
 * exposure, or the daily loss limit. That was the weakest link in the safety
 * chain; this module goes through `checkPrerequisites` like every other path.
 */

import { allMovers } from "./data.js";
import { marketSnapshot } from "./snapshot.js";
import { predict, predictBest } from "./predict.js";
import { research } from "./research.js";
import { AUTO_CHAINS, chainBreaker, profileFor, screenCandidate, allChainStatus } from "../ml/chains.js";
import { checkPrerequisites, liveReadiness } from "./gate.js";
import { planOrder, executeOrder } from "./executor.js";
import { getSettings, insertRow } from "../store.js";
import { buildProposal, shouldPropose } from "./assisted.js";
import { capabilities } from "./capabilities.js";
import { forecastVolatility } from "../ml/forecast.js";
import { resolveHorizonDays } from "../ml/paper.js";

/** How many top performers to consider per chain. */
const CANDIDATES_PER_CHAIN = 8;

/** Minimum liquidity before a token is even looked at, to save API quota. */
const MIN_SCAN_LIQUIDITY_USD = 25_000;

/**
 * A record of one executor decision.
 *
 * Refusals are recorded as carefully as trades. Without them, a malfunctioning
 * executor and a selective one look identical from outside: both produce no
 * orders.
 */
export function logDecision(entry) {
  return insertRow("research_logs", {
    device_id: entry.deviceId,
    token: entry.symbol,
    data_json: {
      kind: "auto_exec",
      chain: entry.chain,
      action: entry.action, // "traded" | "skipped" | "refused"
      reasons: entry.reasons ?? [],
      confidence: entry.confidence ?? null,
      probability: entry.probability ?? null,
      liquidity_usd: entry.liquidity_usd ?? null,
      notional_usd: entry.notional_usd ?? null,
      mode: entry.mode ?? "paper",
    },
    signal: entry.action === "traded" ? entry.side : "HOLD",
    confidence: entry.confidence ?? 0,
  }).catch((err) => {
    console.warn("[autoexec] decision log failed:", err.message);
  });
}

/**
 * Consider one candidate and decide what to do.
 *
 * Exported separately from the loop so it can be tested directly, and so a
 * future "run this check" button reuses exactly this logic rather than
 * re-implementing it and drifting.
 *
 * @returns `{ action, reasons }` — never throws, never places an order directly
 */
export async function considerCandidate({ deviceId, symbol, chain, settings }) {
  const profile = profileFor(chain);
  const breaker = chainBreaker(chain);

  // The chain's own breaker goes first. A halted chain must not even fetch
  // market data — that is wasted API quota on a venue we decided to avoid.
  if (!breaker.canTrade()) {
    return { action: "skipped", reasons: [`${profile.label} is halted: ${breaker.reason}`] };
  }

  let snapshot;
  try {
    snapshot = await marketSnapshot({ symbol, chain: chain === "cex" ? undefined : chain });
  } catch (err) {
    return { action: "skipped", reasons: [`could not read ${symbol}: ${err.message}`] };
  }
  if (!snapshot?.price_usd) return { action: "skipped", reasons: [`no price for ${symbol}`] };

  // Cheap pre-filter before spending a research call on a token too thin to
  // trade regardless of how good the signal looks.
  if (chain !== "cex" && Number(snapshot.liquidity_usd ?? 0) < MIN_SCAN_LIQUIDITY_USD) {
    return {
      action: "skipped",
      reasons: [`$${Math.round(Number(snapshot.liquidity_usd ?? 0)).toLocaleString()} liquidity is too thin to even evaluate`],
    };
  }

  const note = await research(snapshot).catch(() => null);
  const prediction = note?.prediction ?? (await predictBest(snapshot)) ?? predict(snapshot);
  if (!prediction) return { action: "skipped", reasons: ["no prediction available"] };

  const screen = screenCandidate({ chain, snapshot, prediction, profile });
  if (!screen.ok) {
    // Missing the confidence bar is the common, healthy case — not an error.
    // Logged as a skip so the record shows the executor ran and passed.
    return {
      action: "skipped",
      reasons: screen.reasons,
      confidence: prediction.confidence,
      probability: prediction.probability,
      liquidity_usd: snapshot.liquidity_usd,
    };
  }


  // Past this point the candidate is genuinely tradable on venue grounds. The
  // remaining decision belongs to the trade gate, not to this module.
  const mode = settings?.trading_mode === "live" ? "live" : "paper";
  const plan = planOrder(snapshot, prediction, {
    ...settings,
    trading_mode: mode,
    // The chain's own cap, never a global one: a Solana position must not be
    // able to consume the CEX budget.
    max_order_usd: profile.maxNotionalUsd,
  });
  if (!plan) return { action: "skipped", reasons: ["position too small to be worth the fee"] };

  const gate = await checkPrerequisites({
    deviceId,
    symbol: plan.symbol,
    side: plan.side === "BUY" ? "buy" : "sell",
    notionalUsd: plan.notional_usd,
    intent: mode,
    exchangeId: settings?.exchange_id,
    modelBasis: prediction.basis,
    // The chain's breaker stands in for the global one: the global breaker
    // covers app-wide concerns, this one covers this venue.
    breakerOverride: breaker,
  });
  if (!gate.allowed) {
    return {
      action: "refused",
      reasons: gate.failures.map((f) => `${f.name}: ${f.detail}`),
      confidence: prediction.confidence,
      notional_usd: plan.notional_usd,
    };
  }

  if (plan.mode === "live" && capabilities(settings).isAssisted) {
    /**
     * How much this horizon is expected to move, as a decimal return.
     *
     * Taken from the ensemble's own volatility forecast when one exists, because
     * that is the quantity the research found predictable (rank IC 0.187) and it
     * is the honest denominator for "is this trade worth its fees". It is a
     * volatility estimate, not a directional claim — which is exactly why it can
     * be trusted to answer the cost question without any directional skill.
     *
     * Null when unavailable, and null is handled as "do not filter on it" rather
     * than as zero. Treating a missing estimate as zero would mean "this move is
     * worthless" and would suppress every trade on a chain with thin history.
     */
    let expectedMove = null;
    try {
      const closes = (snapshot?.history ?? []).map((b) => b?.c).filter((c) => Number.isFinite(c) && c > 0);
      const vol = closes.length >= 30 ? forecastVolatility(closes, { horizon: resolveHorizonDays(prediction.basis) }) : null;
      if (vol?.overHorizon > 0) expectedMove = vol.overHorizon;
    } catch {
      expectedMove = null;
    }

    /**
     * Assisted mode: stage the decision, stop.
     *
     * The order is never placed here and no venue is contacted. `buildProposal`
     * is pure, so this branch has no side effects beyond writing a row the user
     * can read and then sign (or decline) from their wallet.
     *
     * `shouldPropose` is the important call. Without it the auto-trader would
     * queue a proposal for every marginal signal, the user would learn to approve
     * reflexively, and the mode's whole safety property would quietly evaporate.
     * Proposing less is what keeps the prompts worth reading.
     */
    const proposal = buildProposal(
      { ...plan, device_id: deviceId },
      {
        probUp: prediction.probability,
        confidence: prediction.confidence,
        model: prediction.basis,
        expectedMove,
      },
    );
    const verdict = shouldPropose(proposal, { gate, expectedMove, costBps: 34 });
    if (!verdict.ok) {
      // Not a failure: the app considered a trade and judged it not worth
      // bothering anyone about. Recorded, because "we stayed quiet" is part of
      // how a user judges whether the system is sane.
      return {
        action: "stayed_quiet",
        reasons: [verdict.why],
        confidence: prediction.confidence,
      };
    }
    await insertRow("proposals", { device_id: deviceId, ...proposal });
    return {
      action: "proposed",
      reasons: ["awaiting your signature in your wallet"],
      proposal_id: proposal.id,
      confidence: prediction.confidence,
      notional_usd: plan.notional_usd,
    };
  }

  // In live mode the order goes to the exchange; in paper mode it is booked
  // locally. `executeOrder` parks anything it cannot send, so a failed live
  // order degrades to a record rather than a silent loss.
  const order = await executeOrder(deviceId, plan);
  return {
    action: "traded",
    order,
    side: plan.side,
    confidence: prediction.confidence,
    probability: prediction.probability,
    notional_usd: plan.notional_usd,
    liquidity_usd: snapshot.liquidity_usd,
    mode,
  };
}

/**
 * One pass over every enabled chain: find top performers, consider each.
 *
 * Chains are processed in priority order (majors first) and each one's
 * candidates are considered sequentially, so a slow or failing venue cannot
 * starve the others.
 *
 * @returns a per-chain summary for the dashboard
 */
export async function runAutoExecutor(deviceId, opts = {}) {
  const settings = (await getSettings(deviceId).catch(() => null)) ?? {};
  if (settings.autopilot === false) {
    return { ran: false, reason: "autopilot is switched off in Settings" };
  }

  const chains = opts.chains ?? AUTO_CHAINS;
  const results = [];

  for (const chain of chains) {
    const profile = profileFor(chain);
    const breaker = chainBreaker(chain);
    if (!breaker.canTrade()) {
      results.push({ chain, label: profile.label, halted: true, reason: breaker.reason, traded: 0, skipped: 0, refused: 0 });
      continue;
    }

    let movers = [];
    try {
      movers = await allMovers({ limit: CANDIDATES_PER_CHAIN, chain: chain === "cex" ? undefined : chain });
    } catch (err) {
      results.push({ chain, label: profile.label, error: err.message, traded: 0, skipped: 0, refused: 0 });
      continue;
    }

    const summary = { chain, label: profile.label, considered: movers.length, traded: 0, skipped: 0, refused: 0, decisions: [] };
    for (const m of movers.slice(0, CANDIDATES_PER_CHAIN)) {
      const symbol = m.symbol ?? m.id;
      if (!symbol) continue;
      let decision;
      try {
        decision = await considerCandidate({ deviceId, symbol, chain, settings });
      } catch (err) {
        // One bad candidate must never abort the sweep — the remaining chains
        // still need to run.
        decision = { action: "skipped", reasons: [`error: ${err.message}`] };
      }
      summary[decision.action === "traded" ? "traded" : decision.action === "refused" ? "refused" : "skipped"]++;
      summary.decisions.push({ symbol, action: decision.action, reasons: decision.reasons });
      // Every decision is persisted, refusals included.
      await logDecision({ deviceId, symbol, chain, ...decision });
    }
    results.push(summary);
  }

  const traded = results.reduce((s, r) => s + (r.traded ?? 0), 0);
  return {
    ran: true,
    at: new Date().toISOString(),
    traded,
    chains: results,
    // A run that considered candidates and took none is the expected steady
    // state. A run that considered none at all is a fault worth surfacing.
    note: traded === 0 ? "no candidate cleared its chain's thresholds this pass" : `${traded} order(s) placed`,
  };
}

/** Live-trading readiness, for the mode-switch confirmation dialog. */
export async function readiness(deviceId) {
  return liveReadiness(deviceId);
}

/** Per-chain breaker status for the dashboard. */
export function status() {
  return { chains: allChainStatus() };
}
