/**
 * Live check of the DEX collector against the real DexScreener API.
 *
 * Diagnostic, not a test. The unit tests use a hand-written payload, which
 * proves the parser handles THAT shape and nothing more — a provider change
 * that breaks every field would still pass all 12 of them. This makes one real
 * request and reports what came back.
 *
 * Run: node scripts/probe-dex.js
 */
import { collectOnce, quotaStatus, WATCH_CHAINS } from "../src/services/dexwatch.js";

console.log(`chains: ${WATCH_CHAINS.join(", ")}`);

const result = await collectOnce({ chains: ["solana"], limit: 10 });

console.log(`fetched: ${result.fetched}  stored: ${result.stored}  throttled: ${result.budget_denied}`);

for (const r of result.rows.slice(0, 8)) {
  console.log(
    `  ${String(r.symbol).padEnd(12)} liq=${String(r.liquidity_usd ?? "-").padStart(10)} ` +
      `vol=${String(r.volume_usd ?? "-").padStart(10)} ` +
      `chg5m=${String(r.price_change_5m ?? "-").padStart(6)} ` +
      `chg1h=${String(r.price_change_1h ?? "-").padStart(7)} ` +
      `buys=${String(r.buys).padStart(5)} sells=${String(r.sells).padStart(5)}`,
  );
}

// The parse succeeded but produced nothing usable — that is the failure mode
// worth flagging loudly, because it looks identical to "a quiet market".
const usable = result.rows.filter(
  (r) => Number.isFinite(r.liquidity_usd) && Number.isFinite(r.price_change_1h) && r.buys > 0,
);
console.log(`usable rows: ${usable.length}/${result.rows.length}`);
if (result.rows.length > 0 && usable.length === 0) {
  console.log("FAIL: rows parsed but none carry the fields the features need.");
}

console.log("quota:", JSON.stringify(quotaStatus(), null, 2));