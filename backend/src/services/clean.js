/**
 * Input cleaning shared by the market-data sources.
 *
 * These run on every value that comes from a public feed, which means the
 * input is untrusted. Promoted listings in particular are unvetted: the feeds
 * routinely carry 2,000-character "symbols" and coin names containing emoji.
 */

/** Number or null. Never NaN, never Infinity — those poison sorting. */
export function numberOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Reduce a feed-provided symbol to something a human can read and an exchange
 * would recognise: uppercase, no whitespace, and short.
 */
export function cleanSymbol(raw) {
  const cleaned = String(raw ?? "")
    .replace(/[^\p{L}\p{N}]/gu, "")
    .toUpperCase();
  // Reject rather than truncate. A real ticker is a handful of characters; a
  // 20-character "ticker" is a feed artefact, and truncating it would invent
  // a symbol pointing at a coin which does not exist. An empty string makes
  // the caller drop the row.
  return cleaned.length > 12 ? "" : cleaned;
}

/** Same idea for the display name, with a length cap and a safe fallback. */
export function cleanName(raw) {
  const s = String(raw ?? "").replace(/\s+/g, " ").trim();
  return s.length && s.length <= 48 ? s : "Unknown coin";
}
