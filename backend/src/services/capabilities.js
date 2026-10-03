/**
 * The three orthogonal trading fields.
 *
 * The app previously had one field, `trade_style`, with values `paper`,
 * `assisted` and `autonomous`. That conflated two independent questions, and the
 * combinations it admitted included nonsense: "assisted" and "paper" together, or
 * "autonomous" with a wallet that cannot sign.
 *
 * The real questions are orthogonal:
 *
 *   trading_mode    Does money move?          paper | live
 *   trade_authority Who signs?                 auto | approve
 *   custody         Where does the key live?  cex_key | wallet
 *
 * All eight combinations are meaningful, and each is reachable:
 *
 *   paper  + any                 simulation; never leaves the machine
 *   live   + auto   + cex_key    fully autonomous, works today
 *   live   + auto   + wallet      session keys; requires granted authority
 *   live   + approve + cex_key    the app sizes, the user confirms
 *   live   + approve + wallet     the current assisted mode
 *
 * Splitting them also fixes a real bug: `custody: wallet` combined with
 * `trade_authority: auto` previously looked identical to assisted mode and asked
 * for API credentials the user does not have and must never give.
 *
 * Unknown values fail closed to the safest cell of each axis rather than throwing.
 * A settings row written by an older version, or hand-edited, must not be able to
 * accidentally unlock trading.
 */

export const TRADING_MODES = ["paper", "live"];
export const AUTHORITIES = ["auto", "approve"];
export const CUSTODIES = ["cex_key", "wallet"];

/** Resolve a settings object to a validated, fail-closed capability triple. */
export function capabilities(settings = {}) {
  const trading_mode = TRADING_MODES.includes(settings.trading_mode) ? settings.trading_mode : "paper";
  // `auto` is the more dangerous value, so an unrecognised authority must not
  // default to it. Unknown becomes "approve": the user decides.
  const trade_authority = AUTHORITIES.includes(settings.trade_authority) ? settings.trade_authority : "approve";
  const custody = CUSTODIES.includes(settings.custody) ? settings.custody : "cex_key";
  return {
    trading_mode,
    trade_authority,
    custody,
    /** Simulation. Nothing can reach a venue regardless of the other two axes. */
    isPaper: trading_mode === "paper",
    /** The app may place an order without asking anyone. */
    isAutonomous: trading_mode === "live" && trade_authority === "auto",
    /** The app proposes; a human decides. */
    isAssisted: trading_mode === "live" && trade_authority === "approve",
    /** Autonomous *and* the server holds a signing key. The only fully unattended cell. */
    canSignServerSide: trading_mode === "live" && trade_authority === "auto" && custody === "cex_key",
  };
}

/**
 * What the app will actually do, in one sentence.
 *
 * Every combination is described, including the impossible-looking ones, so the
 * UI never has to infer behaviour from three values. This is the text a user reads
 * before giving away control, and "we inferred something" is not an acceptable
 * answer to "what will this do with my money".
 */
export function describeCapabilities(caps) {
  const { trading_mode: mode, trade_authority: authority, custody: custodyKind } = caps;
  if (mode === "paper") {
    return "Practice only. No orders leave this machine, whatever the other settings say.";
  }
  if (authority === "approve") {
    return custodyKind === "wallet"
      ? "The app decides what to trade and when. You sign each trade in your wallet — your keys never reach us."
      : "The app decides what to trade and when. You confirm each order before it is sent.";
  }
  return custodyKind === "wallet"
    ? "Unattended trading from a wallet. This needs session keys you have granted, and is not available yet — without them the app will propose trades instead of placing them."
    : "The app places and signs real orders unattended, using the API keys you connected.";
}
