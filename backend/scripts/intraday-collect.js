/**
 * Intraday collector CLI.
 *
 *   npm run collect -- --interval 15m --bars 2000 --once
 *
 * A thin wrapper around the runner in `ml/intraday.js`. The logic lives in `src`
 * so the server can start the same collector on a timer; this exists so history
 * can also be backfilled on a machine that is not serving.
 */

import { collectOnce, startIntradayCollector } from "../src/ml/intraday.js";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const opts = { interval: arg("interval", "15m"), bars: Number(arg("bars", 2000)) };

if (process.argv.includes("--once")) {
  const results = await collectOnce(opts);
  const totalAdded = results.reduce((s, r) => s + r.added, 0);
  for (const r of results) {
    console.log(
      r.ok
        ? `[collect] ${r.pair.padEnd(14)} +${String(r.added).padStart(5)} new  (${r.total} stored)`
        : `[collect] ${r.pair.padEnd(14)} FAILED: ${r.error}`,
    );
  }
  console.log(`[collect] ${opts.interval} · ${totalAdded} new bars across ${results.length} pairs`);
} else {
  console.log(`[collect] starting ${opts.interval} collector; ctrl-c to stop`);
  startIntradayCollector(opts);
}
