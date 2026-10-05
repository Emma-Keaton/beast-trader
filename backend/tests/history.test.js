/**
 * History cache tests — specifically `fetchDailyBars(..., { offline: true })`.
 *
 * Why these exist: `train --offline` was documented as "use only cached history
 * (no network)" but the cache read had a 12-hour TTL. On any machine that trains
 * less often than every 12 hours — i.e. every machine — `--offline` silently
 * refetched from Binance, so the flag was a lie. Worse, when Binance rate-limited
 * the refetch, training failed in "offline" mode.
 *
 * Every guard here is proven non-vacuous:
 *  - the stale-cache test stubs `fetch` to record calls, so it fails if the TTL
 *    is reapplied to offline reads;
 *  - the no-cache test fails if offline falls through to a network fetch;
 *  - the online test fails if the TTL is removed entirely (freshness for live
 *    scoring would be lost).
 *
 * Tests never touch the real network: `fetch` is stubbed for every case that
 * could reach it.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { config } from "../src/config.js";
import { fetchDailyBars } from "../src/ml/history.js";

const CACHE_DIR = path.join(config.dataDir, "history");

/** Write a cache entry for `id` and backdate its mtime past the 12h TTL. */
function seedCache(id, { ageMs } = {}) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const file = path.join(CACHE_DIR, `${id}.json`);
  const bars = Array.from({ length: 200 }, (_, i) => ({
    t: 1_700_000_000_000 + i * 86_400_000,
    o: 100, h: 101, l: 99, c: 100.5, v: 10,
  }));
  fs.writeFileSync(
    file,
    JSON.stringify({ id, symbol: id.toUpperCase(), bars, source: "binance", fetchedAt: new Date().toISOString() }),
  );
  if (ageMs) {
    const past = new Date(Date.now() - ageMs);
    fs.utimesSync(file, past, past);
  }
  return file;
}

/** Replace global fetch with a recorder for the duration of `fn`. */
async function withFetchSpy(fn) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    throw new Error("network must not be used in this test");
  };
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = real;
  }
}

test("offline serves a cache older than the TTL instead of refetching", async () => {
  const file = seedCache("offline-stale-fixture", { ageMs: 48 * 3600_000 });
  try {
    await withFetchSpy(async (calls) => {
      const data = await fetchDailyBars("offline-stale-fixture", "STALE", 5000, { offline: true });
      assert.equal(data.cached, true, "stale cache must still count as a hit when offline");
      assert.ok(data.bars.length >= 100, "the seeded bars come back intact");
      assert.equal(calls.length, 0, "offline must never reach the network");
    });
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test("offline with no cache throws before any network fetch", async () => {
  const id = "offline-missing-fixture";
  fs.rmSync(path.join(CACHE_DIR, `${id}.json`), { force: true });
  await withFetchSpy(async (calls) => {
    await assert.rejects(
      () => fetchDailyBars(id, "MISSING", 5000, { offline: true }),
      /no cached history \(offline mode\)/,
      "an absent cache must be an error, not a reason to fetch",
    );
    assert.equal(calls.length, 0, "the error must come from the offline guard, not from fetch failing");
  });
});

test("online still honours the TTL: a stale cache is refetched", async () => {
  const file = seedCache("online-stale-fixture", { ageMs: 48 * 3600_000 });
  try {
    await withFetchSpy(async (calls) => {
      await assert.rejects(
        () => fetchDailyBars("online-stale-fixture", "STALE", 5000),
        /network must not be used/,
        "a stale cache in online mode must attempt a refetch",
      );
      assert.ok(calls.length > 0, "the TTL guard is still doing its job for live scoring");
    });
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test("online serves a fresh cache without refetching", async () => {
  const file = seedCache("online-fresh-fixture");
  try {
    await withFetchSpy(async (calls) => {
      const data = await fetchDailyBars("online-fresh-fixture", "FRESH", 5000);
      assert.equal(data.cached, true);
      assert.equal(calls.length, 0, "a cache inside the TTL is a hit");
    });
  } finally {
    fs.rmSync(file, { force: true });
  }
});
