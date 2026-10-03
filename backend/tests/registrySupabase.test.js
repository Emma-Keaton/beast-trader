/**
 * The Supabase-backed registry, exercised against a stub PostgREST.
 *
 * Every other test in this suite runs with Supabase unconfigured, so it only
 * ever exercises the local-disk fallback. That fallback is the development
 * path; the Supabase path is what runs in production, and it is the one that
 * matters — Render's ephemeral filesystem deletes the on-disk copy on every
 * spin-down, so a bug that only appeared when Supabase was configured would
 * wipe the entire learning history in production while every local test passed.
 *
 * `usingSupabase` is computed once when config.js loads, so the env vars must be
 * set before anything imports it. Node's test runner gives each file its own
 * process, so setting them at the top of this file is safe.
 */
process.env.SUPABASE_URL = "https://stub.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";

const test = (await import("node:test")).default;
const assert = (await import("node:assert/strict")).default;

const calls = [];
let store = [];

/** Minimal PostgREST stand-in covering the shapes the registry uses. */
function stubFetch() {
  return async (url, opts = {}) => {
    const u = String(url);
    const method = opts.method ?? "GET";
    calls.push({ u, method, body: opts.body ? JSON.parse(opts.body) : null });
    const json = (rows) => ({ ok: true, status: 200, json: async () => rows });

    if (u.includes("/model_registry") && method === "GET") return json(store);
    if (u.includes("/model_registry") && method === "POST") {
      const row = JSON.parse(opts.body);
      store = store.filter((r) => r.id !== row.id);
      store.push({ ...row, created_at: "2026-01-01T00:00:00Z" });
      return { ok: true, status: 201, json: async () => [] };
    }
    if (u.includes("/model_registry") && method === "DELETE") {
      const id = new URL(u).searchParams.get("id")?.replace("eq.", "");
      store = store.filter((r) => r.id !== id);
      return { ok: true, status: 204, json: async () => [] };
    }
    return json([]);
  };
}

/** Install the stub as the global fetch and import the registry against it. */
globalThis.fetch = stubFetch();
const strategies = await import("../src/ml/strategies.js");
const { usingSupabase } = await import("../src/config.js");

test("the registry is actually running in Supabase mode", () => {
  // If this fails, every test below silently exercises the disk fallback and
  // proves nothing about production.
  assert.equal(usingSupabase, true);
});

test.beforeEach(() => {
  calls.length = 0;
  store = [];
});

test("a champion is written to Supabase, not just to disk", async () => {
  await strategies.warmRegistry();
  await strategies.setChampion({ scaler: { mean: [0], std: [1] }, weights: [1], bias: 0 });
  const post = calls.find((c) => c.method === "POST" && c.u.includes("/model_registry"));
  assert.ok(post, "the champion must be persisted to Supabase");
  assert.equal(post.body.id, "champion");
  assert.equal(post.body.role, "champion");
  assert.deepEqual(post.body.payload.weights, [1]);
});

test("an evicted challenger is deleted, not left as a ghost row", async () => {
  await strategies.warmRegistry();
  await strategies.proposeChallenger({ scaler: { mean: [0], std: [1] }, weights: [1], bias: 0 }, { id: "keep" });
  await strategies.proposeChallenger({ scaler: { mean: [0], std: [1] }, weights: [2], bias: 0 }, { id: "drop" });
  await strategies.retireChallenger("drop");

  const del = calls.find((c) => c.method === "DELETE" && c.u.includes("id=eq.drop"));
  assert.ok(del, "retiring must issue a DELETE");
  assert.equal(store.some((r) => r.id === "drop"), false);
  assert.equal(store.some((r) => r.id === "keep"), true);
});

test("a settled outcome reaches the durable store", async () => {
  await strategies.warmRegistry();
  await strategies.proposeChallenger({ scaler: { mean: [0], std: [1] }, weights: [1], bias: 0 }, { id: "c1" });
  await strategies.recordChallengerOutcome("c1", 0.02);
  const row = store.find((r) => r.id === "c1");
  assert.ok(row, "the challenger row exists");
  assert.deepEqual(row.track_record.returns, [0.02], "the outcome survived the write");
});

test("the registry is reconstructed from Supabase rows after a restart", async () => {
  await strategies.warmRegistry();
  await strategies.setChampion({ scaler: { mean: [0], std: [1] }, weights: [7], bias: 0 });
  await strategies.proposeChallenger({ scaler: { mean: [0], std: [1] }, weights: [3], bias: 0 }, { id: "c1" });

  // Simulate a fresh process: nothing in memory, everything from the store.
  store.length = 0;
  store.push(
    { id: "champion", role: "champion", payload: { scaler: { mean: [0], std: [1] }, weights: [7], bias: 0 } },
    {
      id: "c1",
      role: "challenger",
      payload: { scaler: { mean: [0], std: [1] }, weights: [3], bias: 0 },
      track_record: null,
    },
  );
  const second = await import(`../src/ml/strategies.js?restart=${Date.now()}`);
  await second.warmRegistry();
  assert.ok(second.getChampion(), "champion survives a restart");
  assert.deepEqual(second.getChampion().weights, [7]);
  assert.equal(second.listChallengers().length, 1);
  assert.equal(second.listChallengers()[0].id, "c1");
});