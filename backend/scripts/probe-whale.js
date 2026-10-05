/**
 * Live check of the whale flow collector against the real Helius API.
 *
 * Diagnostic, not a test. The unit tests parse a hand-written payload, which
 * proves the parser handles THAT shape and nothing more — a Helius payload
 * change that breaks every field would still pass all 18 of them, and the
 * failure would look exactly like "a quiet market": empty whale_flows rows
 * nobody notices until a model trains without them. This makes one real
 * request per tracked mint and reports what came back.
 *
 * Behavior:
 *   node scripts/probe-whale.js            full path, persists new flows
 *   node scripts/probe-whale.js --dry-run  fetch + parse only, writes nothing
 *
 * Persisting by default is deliberate: it proves the whole chain, including
 * that `whale_flows` exists with the right columns. Dedup is by flow key, so
 * rows written here are not double-written by the next collector tick.
 *
 * Exits 0 keyless (prints the disabled message) — a keyless machine is a
 * normal state, not a failure.
 */
import { collectOnce, trackedMints, whaleStatus, MIN_WHALE_USD } from "../src/services/whalewatch.js";
import { config } from "../src/config.js";

const dryRun = process.argv.includes("--dry-run");
const mints = trackedMints();

console.log(`mints: ${Object.keys(mints).join(", ")}  floor: $${MIN_WHALE_USD.toLocaleString("en-US")}/flow`);
console.log(`mode: ${dryRun ? "dry-run (nothing written)" : "live (new flows persist)"}`);

if (!config.heliusApiKey) {
  // The keyless contract: report it precisely and stop. Distinguishing "not
  // set" from "set but rejected" matters — one is configuration, the other is
  // a broken key, and they need different fixes.
  console.log("HELIUS_API_KEY not set — collector disabled (app runs normally).");
  console.log("Set it in backend/.env or the repo-root .env to run this probe live.");
  process.exit(0);
}

let written = 0;
const result = await collectOnce({
  mints,
  ...(dryRun ? { persist: async (rows) => { written = rows.length; return rows.length; } } : {}),
});

console.log(
  `fetched=${result.fetched} parsed=${result.parsed} stored=${result.stored} ` +
    `dup=${result.duplicates} denied=${result.budget_denied} no_price=${result.prices_unavailable}`,
);

if (dryRun) console.log(`dry-run would have stored ${written} new flow(s)`);

// Parse succeeded but produced nothing usable — the failure mode worth
// flagging loudly, because it is indistinguishable from a quiet market when
// you only ever look at row counts. (A null price skips parsing entirely, so
// that case is excluded rather than misreported as parser drift.)
if (result.enabled && result.fetched > 0 && result.parsed === 0 && result.prices_unavailable === 0) {
  console.log("FAIL: transactions fetched but none parsed into flows — check the parser against the live payload.");
}

console.log("status:", JSON.stringify(whaleStatus(), null, 2));
