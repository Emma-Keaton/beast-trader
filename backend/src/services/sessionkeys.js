/**
 * Bounded, revocable authority for unattended wallet trading.
 *
 * The problem. A wallet key cannot be signed server-side, so the app cannot trade
 * unattended from a wallet without *some* key it can use. The tempting answer is
 * to ask the user for their seed phrase or main private key. That answer is
 * unacceptable: one compromise empties the account, and a user who pasted their
 * seed into a web app has been told to expect to lose everything.
 *
 * The correct answer on Solana is a **session key**: a disposable keypair whose
 * authority is scoped, time-boxed, spend-limited and revocable on-chain. The user
 * signs one approval in their wallet; from then on the app holds only the session
 * key, and that key can do nothing the approval did not permit.
 *
 * This is why Solana first. The EVM equivalent needs a smart account (ERC-4337,
 * Safe modules, Zodiac) - a contract to deploy, gas to pay, and an external
 * provider to depend on. Solana has had native session keys for years, needs no
 * contract deployment, and costs a fraction of a cent per transaction. For an app
 * that trades small and often, that difference is decisive.
 *
 * The limits below are not caller-configurable, on purpose. A user who can set
 * "unlimited value, no expiry" from a settings screen will, and a leak then means
 * a total loss. These limits are the product.
 */

/** Fixed, deliberately tight. Not caller-configurable. */
export const SESSION_LIMITS = Object.freeze({
  /** Session keys expire. A key that never expires is a permanent authorisation. */
  ttlHours: 24,
  /** Total notional the session may spend, in USD, across all its trades. */
  maxTotalUsd: 500,
  /** Per-trade ceiling. A session may not open one large position. */
  maxPerTradeUsd: 100,
  /** Expiry is additionally enforced on-chain by block height. */
  maxAgeBlocks: 150000,
});

/**
 * Build the approval a user is asked to sign.
 *
 * This does not sign and cannot. It produces the instruction and hands it to the
 * wallet, where the user sees it before anything is authorised.
 *
 * `programs` is an allowlist. A session key that can call arbitrary programs is a
 * session key that can be drained by any of them, so an empty list is refused
 * rather than accepted as a session that happens to do nothing - that would look
 * meaningful in the wallet prompt and not be.
 */
export function buildSessionApproval({ payer, programs, authoritySeed }) {
  if (!payer) throw new Error("a payer account is required");
  if (!authoritySeed) throw new Error("a session keypair is required");
  if (!Array.isArray(programs) || !programs.length) {
    throw new Error("a session key with no permitted programs would be useless");
  }
  return {
    instructions: [
      {
        program: "solana-program-derived-authority",
        createSessionAuthority: {
          payer,
          programs,
          maxAgeBlocks: SESSION_LIMITS.maxAgeBlocks,
          maxTotalUsd: SESSION_LIMITS.maxTotalUsd,
          maxPerTradeUsd: SESSION_LIMITS.maxPerTradeUsd,
        },
      },
    ],
    sessionPubkey: authoritySeed,
    authority: payer,
    limits: SESSION_LIMITS,
  };
}

/**
 * Can this session still trade?
 *
 * Enforced on every order, not just at issue time. Client-side, so advisory
 * against a determined attacker holding the key - but it catches every ordinary
 * mistake, which is the overwhelming majority of what would otherwise go wrong.
 */
export function sessionUsable(session, nowMs = Date.now()) {
  if (!session) return { ok: false, why: "no session key" };
  if (Number.isFinite(session.currentBlock) && session.currentBlock > session.expiresAtBlock) {
    return { ok: false, why: "session key has expired" };
  }
  const ageHours = (nowMs - session.createdAtMs) / 3600000;
  if (ageHours > SESSION_LIMITS.ttlHours) {
    return { ok: false, why: "session key is older than 24 hours" };
  }
  if ((session.spentUsd ?? 0) >= SESSION_LIMITS.maxTotalUsd) {
    return { ok: false, why: "session has spent its full allowance" };
  }
  return { ok: true, why: "session is valid" };
}

/**
 * May this session take a trade of `notionalUsd`?
 *
 * Spend limits are checked cumulatively *and* per-trade. Checking only the total
 * would let a session that already spent $450 open one $500 position, which is
 * what "limited" has to mean to be worth anything.
 */
export function canSpend(session, notionalUsd) {
  const usable = sessionUsable(session);
  if (!usable.ok) return usable;
  if (!Number.isFinite(notionalUsd) || notionalUsd <= 0) {
    return { ok: false, why: "trade size must be a positive number" };
  }
  if (notionalUsd > SESSION_LIMITS.maxPerTradeUsd) {
    return {
      ok: false,
      why: `a session key cannot open a $${notionalUsd} position — the per-trade ceiling is $${SESSION_LIMITS.maxPerTradeUsd}`,
    };
  }
  const remaining = SESSION_LIMITS.maxTotalUsd - (session?.spentUsd ?? 0);
  if (notionalUsd > remaining) {
    return { ok: false, why: `only $${remaining.toFixed(2)} of this session's allowance remains` };
  }
  return { ok: true, why: "within session limits" };
}

/**
 * Revoke.
 *
 * Always available and never conditional. A session that is only revocable while
 * everything is healthy is not revocable. One instruction ends the authority
 * immediately and no further trade can be signed against it.
 */
export function buildRevocation(authority) {
  if (!authority) throw new Error("an authority address is required");
  return {
    instructions: [{ program: "solana-program-derived-authority", revoke: { authority } }],
  };
}

/** How much a session has left. Shown to the user, who should never be surprised. */
export function sessionRemaining(session) {
  const spent = session?.spentUsd ?? 0;
  return {
    spentUsd: Number(spent.toFixed(2)),
    remainingUsd: Number(Math.max(0, SESSION_LIMITS.maxTotalUsd - spent).toFixed(2)),
    totalUsd: SESSION_LIMITS.maxTotalUsd,
    perTradeUsd: SESSION_LIMITS.maxPerTradeUsd,
    expiresInHours: session ? Math.max(0, SESSION_LIMITS.ttlHours - (Date.now() - session.createdAtMs) / 3600000) : 0,
  };
}