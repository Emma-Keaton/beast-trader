/**
 * Preload module. Runs inside EVERY test process, before any application import.
 *
 * WHY THIS EXISTS
 * The suite was reaching the REAL Supabase database ("supabase insert orders:
 * 400", and a test asserting against a collection that did not exist). Two
 * independent mechanisms caused it, both found by making the isolation test fail
 * rather than by reasoning about it:
 *
 *  1. `--env-file` does not override variables that are already set in the
 *     process environment; it only fills in unset ones. So the `SUPABASE_URL=`
 *     line in .env.test was silently ignored on any shell where Supabase is
 *     exported. On a clean shell it genuinely worked, which is exactly why the
 *     bug survived.
 *
 *  2. `src/config.js` runs its OWN `loadEnv()` at import time, re-reading
 *     backend/.env and the repo-root .env, and it only fills in keys that are
 *     ABSENT (`!(key in process.env)`). Deleting the variable is therefore not
 *     enough — importing config restores it from disk. This is what made the
 *     first attempt look broken: the variable was clean at preload and dirty
 *     again by the time any test body ran.
 *
 * Both delete AND set-to-empty are needed below, for those two distinct reasons.
 *
 * Loaded via `--import`, which runs before the test file, which runs before
 * config.js. Scrubbing in the `pretest` script instead would NOT work: that is a
 * separate process and cannot affect the `npm test` process that follows.
 */
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

// Empty string, not just absent: config.js's loader skips keys that are already
// present, so an empty string is what actually blocks the restore from disk.
process.env.SUPABASE_URL = "";
process.env.SUPABASE_SERVICE_ROLE_KEY = "";

// Safety net: if DATA_DIR ever resolves to the real data directory, refuse to
// start rather than write test state into the real paper track record.
if (process.env.DATA_DIR) {
  const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  const resolved = new URL(process.env.DATA_DIR, `file://${root}/`).pathname.replace(
    /^\/([A-Za-z]:)/,
    "$1",
  );
  if (resolved.replace(/\\/g, "/").endsWith("/data")) {
    console.error("[test-env] refusing to run: DATA_DIR points at the real data directory.");
    process.exit(1);
  }
}