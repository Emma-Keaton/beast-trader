/**
 * Runs the DEX collector once, for real, against the configured database.
 *
 * Diagnostic. `scripts/probe-dex.js` proves the fetch and parse work; this proves
 * the PERSIST path works too, which is a different failure: an insert that
 * returns 200 while writing nothing usable, or a table that does not exist yet.
 * Those look identical from the collector's side unless something actually runs
 * the write.
 *
 * Run: node --env-file=.env scripts/run-dex.js
 */
import { config, usingSupabase } from "../src/config.js";
import { tick, quotaStatus } from "../src/services/dexwatch.js";
import { listAllRows } from "../src/store.js";

console.log(`storage: ${usingSupabase ? "supabase" : "local json"}`);
console.log(`dataDir: ${config.dataDir}`);

const result = await tick({ chains: ["solana"] });

console.log(`fetched=${result.fetched} stored=${result.stored} throttled=${result.budget_denied}`);

// Read back rather than trusting the write. `stored` is what we sent; this is
// what actually landed, which is the only number that proves anything.
try {
  const rows = await listAllRows("dex_snapshots", "ts.desc", 100);
  console.log(`dex_snapshots rows readable: ${rows.length}`);
  if (rows.length) {
    const r = rows[0];
    console.log(`  newest: ${r.symbol} liq=${r.liquidity_usd} chg1h=${r.price_change_1h} buys=${r.buys} ts=${r.ts}`);
    const usable = rows.filter((x) => Number.isFinite(Number(x.price_change_1h)));
    console.log(`  usable (has price movement): ${usable.length}/${rows.length}`);
  }
} catch (err) {
  console.error(`READBACK FAILED: ${err.message}`);
  console.error("This usually means the dex_snapshots table does not exist yet.");
  console.error("Run the new section of supabase/schema.sql in the SQL editor.");
}

console.log("quota:", JSON.stringify(quotaStatus().dexscreener_pairs_remaining));