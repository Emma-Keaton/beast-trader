/**
 * Test data root setup. Runs automatically before `npm test` (npm `pretest`).
 *
 * Two jobs, both about making the suite independent of whatever is on the machine.
 *
 * 1. Wipe the test data root. The suite is stateful by design — `retrain.test.js`
 *    asserts `listChallengers().length === 1`, which is only true from a clean
 *    slate. A run killed mid-flight leaves a challengers.json behind and the next
 *    run fails with an assertion error that points at the test rather than at the
 *    stale file. Starting from empty removes that entire failure mode.
 *
 * 2. Seed the trained model. `prediction.test.js` skips its model-tier assertions
 *    when `MODEL_FILE` is absent, so an empty data root would silently drop that
 *    coverage. Copying the committed model in keeps the tests running against the
 *    real artifact without letting them write to it.
 *
 * NAMING — do not rename this to `test-*.js`, `*.test.js`, or move it under a
 * `test/` directory. `node --test` collects files matching those patterns as test
 * files and runs them concurrently with the real suite. When this script was named
 * `test-setup.js`, the runner picked it up as a test, wiped the data directory
 * *while* `retrain.test.js` was mid-run, and the suite failed with "enough settled
 * calls produces a challenger". A script that deletes state is only safe when it
 * runs strictly before the tests, never beside them.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Delete the Supabase credentials from the environment before anything else.
//
// `--env-file` does NOT override variables that are already set in the process
// environment — it only fills in unset ones. So `SUPABASE_URL=` in .env.test is
// silently ignored on any machine where Supabase is exported in the shell, and
// the suite runs against the REAL database: it inserted test rows and got
// "supabase insert orders: 400". Deleting the key is the only thing that works,
// because an absent variable is one `--env-file` will actually apply.
//
// This has to happen here, in `pretest`, because a test process that never runs
// this script would otherwise read the live credentials straight from the shell.
for (const key of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
  if (process.env[key]) {
    delete process.env[key];
    console.log(`[test-setup] scrubbed ${key} from the environment`);
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(here, "..");

// Read DATA_DIR the same way `src/config.js` does, for the same reason: so the
// directory this script wipes is exactly the directory the tests will use.
const dataDir = process.env.DATA_DIR
  ? path.resolve(backendRoot, process.env.DATA_DIR)
  : path.join(backendRoot, "data");

// Refuse to wipe the real data root. A missing DATA_DIR in the environment would
// otherwise turn `npm test` into "delete the paper track record", which is the
// exact accident this whole mechanism exists to prevent.
if (path.resolve(dataDir) === path.resolve(path.join(backendRoot, "data"))) {
  console.error(
    "[test-setup] refusing to run: DATA_DIR resolves to the real data directory.\n" +
      "             Run the suite via `npm test` (which loads .env.test) or set DATA_DIR.",
  );
  process.exit(1);
}

// maxRetries/retryDelay are not optional on Windows: removing a directory tree
// while a handle is still closing raises ENOTEMPTY, which failed the suite with
// "ENOTEMPTY, Directory not empty: .test-data\strategies" for no real reason.
fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
fs.mkdirSync(path.join(dataDir, "models"), { recursive: true });

// Seed whichever trained model is committed, preferring the newest layout —
// the same order registry.js resolves candidates in, so what the tests load is
// what a deployment would load.
const committedModelsDir = path.join(backendRoot, "data", "models");
const committed = ["direction-v3.json", "direction-v2.json"]
  .map((f) => path.join(committedModelsDir, f))
  .find((f) => fs.existsSync(f));
if (committed) {
  fs.copyFileSync(committed, path.join(dataDir, "models", path.basename(committed)));
  console.log("[test-setup] seeded trained model into", path.relative(backendRoot, dataDir));
} else {
  console.log("[test-setup] no trained model to seed; model-tier tests will skip");
}

console.log("[test-setup] test data root reset:", path.relative(backendRoot, dataDir));