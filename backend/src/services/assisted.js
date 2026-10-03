/**
 * Assisted mode: the auto-trader proposes, the human signs.
 *
 * The goal this serves. The user connects a venue once, picks a trading mode and
 * picks the tokens to watch; after that they should not have to operate anything.
 * Assisted mode is the only way to reach that for a wallet, and it is a real
 * answer rather than a consolation prize: the auto-trader does all the work of
 * deciding *what* to trade, *when*, and *how much*, and the human contributes a
 * single signature at the moment capital actually moves.
 *
 * Why the signature is unavoidable for wallets. A CEX key lives on the server, so
 * the server can sign. A wallet key lives in a browser extension, so it cannot.
 * There is no connector that changes this — only session keys (Solana) or a
 * spending policy / ERC-4337 module (EVM) let a program act unattended, and both
 * are a bounded-authority grant the user must sign for explicitly. Assisted mode
 * is the version that requires no such grant.
 *
 * The design rule that matters: **the app never holds key material and never
 * decides to spend.** It builds a proposal, shows the user exactly what it is, and
 * waits. If the user walks away, nothing happens. If the app is compromised, the
 * attacker can propose trades — which the user still sees and still refuses —
 * but cannot sign one.
 *
 * This is meaningfully weaker than autonomous CEX trading, and the UI must not
 * pretend otherwise. What it buys is that the failure mode is "nothing happened",
 * not "money moved".
 */

export const PROPOSAL_STATUS = {
  /** Built, waiting on the user to sign. */
  PENDING: "pending_signature",
  /** The user signed and the venue accepted it. */
  EXECUTED: "executed",
  /** The user declined, or the window lapsed. */
  DECLINED: "declined",
  /** Signed, sent, rejected by the venue. */
  FAILED: "failed",
  /** Expired before it was signed. */
  EXPIRED: "expired",
};

/**
 * How long a proposal stays signable.
 *
 * Short on purpose. A price forecast decays fast, and a proposal the user opens
 * after lunch is not the trade that was analysed. Expiry also bounds the damage
 * from a stale queue: the app cannot accumulate signable intents indefinitely and
 * surprise the user with a batch of old trades.
 */
const PROPOSAL_TTL_MS = 15 * 60_000;

/**
 * Build a proposal from a planned order.
 *
 * Note what is *not* here: no signing, no key material, no exchange call. This
 * function is pure — it converts a decision into something a human can read and
 * either approve or refuse. Keeping it pure is what makes the mode auditable; you
 * can replay any proposal and get the identical object.
 *
 * The `reason` fields exist because "the model said buy" is not consentable. The
 * user is being asked to authorise a specific transfer of a specific amount, and
 * the case for it has to be legible in one screen: what it believes, how sure it
 * is, how much it thinks the move is worth, and what it costs to act.
 */
export function buildProposal(plan, { probUp = null, confidence = null, model = null, expectedMove = null, costBps = 34 } = {}) {
  const now = Date.now();
  return {
    id: `prop_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    device_id: plan.device_id ?? null,
    symbol: plan.symbol,
    side: plan.side,
    amount: plan.amount,
    notional_usd: plan.notional_usd ?? null,
    limit_price: plan.limit_price ?? null,
    venue: plan.exchange_id ?? null,
    // Mint address, required to route an actual swap. A symbol is ambiguous across
    // chains and across thousands of long-tail tokens sharing a ticker, so the
    // proposal carries the address rather than making the wallet look it up later.
    token_mint: plan.token_mint ?? null,
    chain: plan.chain ?? null,
    status: PROPOSAL_STATUS.PENDING,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + PROPOSAL_TTL_MS).toISOString(),
    rationale: {
      model,
      prob_up: probUp,
      confidence,
      expected_move: expectedMove,
      // The cost the user is about to pay, next to the move it is meant to
      // capture. If these are close, the trade is not worth signing and the UI
      // should say so rather than presenting it as a normal opportunity.
      round_trip_cost_bps: costBps,
      edge_after_cost:
        Number.isFinite(expectedMove) && Number.isFinite(costBps)
          ? Number((expectedMove - costBps / 1e4).toFixed(6))
          : null,
    },
    // Filled in by the wallet layer after the user signs. Kept on the row so a
    // completed trade can be audited against what was actually proposed.
    signature: null,
    venue_order_id: null,
    decided_at: null,
  };
}

/** Is this proposal still signable? */
export function isLive(proposal, now = Date.now()) {
  if (!proposal) return false;
  if (proposal.status !== PROPOSAL_STATUS.PENDING) return false;
  return Date.parse(proposal.expires_at) > now;
}

/**
 * Record the outcome of the human step.
 *
 * A decline is a first-class, recorded outcome and not a silent drop. How often a
 * user declines, and on which signals, is genuine information about whether the
 * app is proposing sensible things — it belongs in the ledger alongside fills.
 */
export function resolveProposal(proposal, outcome) {
  const { status, signature = null, venueOrderId = null, note = null } = outcome ?? {};
  if (!Object.values(PROPOSAL_STATUS).includes(status)) {
    throw new Error(`unknown proposal status: ${status}`);
  }
  return {
    ...proposal,
    status,
    signature,
    venue_order_id: venueOrderId,
    note,
    decided_at: new Date().toISOString(),
  };
}

/**
 * Whether a proposal is worth showing the user at all.
 *
 * Filters, in order of cost: dead proposals, ones the trade gate refused, and ones
 * whose expected move does not clear costs. The last is the important one — a user
 * signing every prompt is the whole failure mode of this mode, so the app should
 * propose less rather than more. If it asks constantly, they will stop reading.
 */
export function shouldPropose(proposal, { gate = null, expectedMove = null, costBps = 34 } = {}) {
  if (!isLive(proposal)) return { ok: false, why: "expired or already decided" };
  if (gate && gate.allowed === false) {
    return { ok: false, why: `trade gate: ${(gate.failures ?? []).map((f) => f.detail).join("; ")}` };
  }
  if (Number.isFinite(expectedMove) && expectedMove < costBps / 1e4) {
    return { ok: false, why: "expected move does not clear trading costs" };
  }
  return { ok: true };
}

/**
 * What the user should be told about this mode, in one sentence.
 *
 * Surfaced in the UI so assisted mode never reads as full autonomy. The honest
 * framing is that the app proposes and the user signs; the risk that matters is
 * signing something you did not read.
 */
export function describeMode(style) {
  if (style === "autonomous") {
    return "The app trades on its own, using the API keys you connected. Only for venues where that is possible.";
  }
  if (style === "assisted") {
    return "The app decides what to trade and when. You sign each trade in your wallet. Your keys never leave it.";
  }
  return "Paper trading only. No orders leave this machine.";
}

/* ── tests ────────────────────────────────────────────────────────────────── */