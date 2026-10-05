import test from "node:test";
import assert from "node:assert/strict";
import { config, usingSupabase } from "../src/config.js";

/**
 * The suite must never touch the real database.
 *
 * This is not theoretical. `SUPABASE_URL=` in .env.test looked like it disabled
 * Supabase, and for months it appeared to work — because on a shell without the
 * variable exported, `--env-file` really did set it empty. On a machine where
 * Supabase IS exported, --env-file does not override an existing value, so every
 * test ran against production and failed with `supabase insert orders: 400`.
 *
 * The guard runs inside the test process (via --import=./scripts/test-env.js),
 * which is the only place the check means anything: scrubbing the variable in the
 * pretest script proved useless because that is a separate process.
 */
test("the suite is isolated from the real database", () => {
  // Empty-or-absent, not strictly undefined. scripts/test-env.js deletes the
  // variable AND re-sets it to "", because config.js's own loader only fills in
  // keys that are absent — so an empty string is what actually blocks the
  // restore-from-disk, and that empty string is the intended end state.
  //
  // Asserting `undefined` here would fail against a correct implementation,
  // which is how a guard teaches you to weaken it instead of fixing it.
  assert.ok(
    !process.env.SUPABASE_URL,
    `SUPABASE_URL leaked into the test process: ${process.env.SUPABASE_URL}`,
  );
  assert.ok(
    !process.env.SUPABASE_SERVICE_ROLE_KEY,
    "SUPABASE_SERVICE_ROLE_KEY leaked into the test process",
  );
  // The decisive check: what the app itself resolved, not just the environment.
  assert.equal(usingSupabase, false, "config resolved to Supabase during tests");
  assert.equal(config.supabaseUrl, "", "config holds a live Supabase URL during tests");
});

/**
 * And it must never write into the real data directory either. `DATA_DIR` is
 * what keeps test state out of the paper track record.
 */
test("the suite writes to the disposable data root, not the real one", () => {
  assert.notEqual(config.dataDir, undefined);
  assert.ok(
    /[\\/]\.test-data$/.test(config.dataDir),
    `expected a disposable data root, got ${config.dataDir}`,
  );
});