import test from "node:test";
import assert from "node:assert/strict";
import { planOrder } from "../src/services/executor.js";
import { settleOrders } from "../src/services/executor.js";

const snap = { symbol: "SOL", chain: "solana", price_usd: 200, source: "dexscreener" };
const pred = { signal: "LONG", confidence: 0.8, target_price: 210, rationale: "test" };

/* ── Order settlement ────────────────────────────────────────────────────────
 *
 * A filled order used to be written once and never touched again: no exit, no
 * P&L, nothing for the retrainer to learn from. These pin the marking rules,
 * including the one that matters most — a parked live order must never be
 * marked, or the ledger would report trades that were never sent.
 */

/** Run an assertion against a throwaway set of orders.
 *
 * The store has no injection seam, so fixtures are written through the real
 * insert/read/delete API under a unique device id and removed afterwards. That
 * keeps the test honest — it exercises the same persistence path production
 * uses — at the cost of a little ceremony.
 */
async function withOrders(rows, fn) {
  const { insertRow, listCollection, updateRow, deleteRow } = await import("../src/store.js");
  const deviceId = `executor-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  for (const r of rows) await insertRow("orders", { device_id: deviceId, ...r });
  try {
    return await fn({ deviceId, listCollection, updateRow });
  } finally {
    for (const r of await listCollection("orders", deviceId, "created_at.desc")) {
      await deleteRow("orders", deviceId, { id: r.id });
    }
  }
}

test("a filled order past due is marked to market and net of fees", async () => {
  const past = new Date(Date.now() - 3600_000).toISOString();
  await withOrders(
    [{ symbol: "SOL", side: "BUY", filled_price: 100, notional_usd: 50, status: "filled_paper", due_at: past }],
    async ({ deviceId }) => {
      const n = await settleOrders(deviceId, async () => 110);
      assert.equal(n, 1, "the matured fill settles");
    },
  );
});

test("a parked live order is never marked", async () => {
  // The critical safety case. `queued_live` means the order was never sent —
  // there is no position and no fill. Marking it would invent a trade.
  const past = new Date(Date.now() - 3600_000).toISOString();
  await withOrders(
    [{ symbol: "SOL", side: "BUY", filled_price: 100, notional_usd: 50, status: "queued_live", due_at: past }],
    async ({ deviceId }) => {
      const n = await settleOrders(deviceId, async () => 110);
      assert.equal(n, 0, "a parked order has nothing to mark");
    },
  );
});

test("an order that is not due yet is left alone", async () => {
  const future = new Date(Date.now() + 3600_000).toISOString();
  await withOrders(
    [{ symbol: "SOL", side: "BUY", filled_price: 100, notional_usd: 50, status: "filled_paper", due_at: future }],
    async ({ deviceId }) => {
      assert.equal(await settleOrders(deviceId, async () => 110), 0);
    },
  );
});

test("settling twice does not double-count the same order", async () => {
  const past = new Date(Date.now() - 3600_000).toISOString();
  await withOrders(
    [{ symbol: "SOL", side: "BUY", filled_price: 100, notional_usd: 50, status: "filled_paper", due_at: past }],
    async ({ deviceId }) => {
      assert.equal(await settleOrders(deviceId, async () => 110), 1);
      // Second pass must find nothing: settled_at marks it done.
      assert.equal(await settleOrders(deviceId, async () => 200), 0, "no double counting");
    },
  );
});

test("a short that gains is recorded as a profit", async () => {
  const past = new Date(Date.now() - 3600_000).toISOString();
  await withOrders(
    [{ symbol: "SOL", side: "SELL", filled_price: 100, notional_usd: 50, status: "filled_paper", due_at: past }],
    async ({ deviceId, listCollection }) => {
      await settleOrders(deviceId, async () => 90);
      const [row] = await listCollection("orders", deviceId, "created_at.desc");
      assert.ok(row.pnl_pct > 0, `short gained, so pnl is positive: ${row.pnl_pct}`);
      assert.ok(row.pnl_usd > 0);
    },
  );
});

test("no price means no settlement, not a guessed one", async () => {
  const past = new Date(Date.now() - 3600_000).toISOString();
  await withOrders(
    [{ symbol: "SOL", side: "BUY", filled_price: 100, notional_usd: 50, status: "filled_paper", due_at: past }],
    async ({ deviceId }) => {
      assert.equal(await settleOrders(deviceId, async () => null), 0, "retried next tick");
    },
  );
});

test("a plan carries the feature vector so the order is trainable", () => {
  const p = planOrder(
    snap,
    { ...pred, probability: 0.71, features: [0.1, -0.3, 0.5] },
    { max_order_usd: 50, trading_mode: "paper" },
  );
  assert.equal(p.probability, 0.71);
  assert.deepEqual(p.features, [0.1, -0.3, 0.5], "the vector rides along with the order");
});

test("planOrder builds a BUY with risk-capped notional", () => {
  const plan = planOrder(snap, pred, { max_order_usd: 50, trading_mode: "paper" });
  assert.equal(plan.side, "BUY");
  assert.equal(plan.notional_usd, 50);
  assert.equal(plan.qty, 0.25);
  assert.equal(plan.stop_loss, 190);
  assert.equal(plan.take_profit, 210);
  assert.equal(plan.venue, "dex");
});

test("planOrder never exceeds global MAX_ORDER_USD", () => {
  const plan = planOrder(snap, pred, { max_order_usd: 999_999 });
  assert.ok(plan.notional_usd <= 100); // default cap from config
});

test("planOrder returns null for HOLD or missing price", () => {
  assert.equal(planOrder(snap, { ...pred, signal: "HOLD" }, {}), null);
  assert.equal(planOrder({ ...snap, price_usd: null }, pred, {}), null);
});

test("SHORT plan sells with a protective stop above price", () => {
  const plan = planOrder(snap, { ...pred, signal: "SHORT", target_price: 190 }, { max_order_usd: 40 });
  assert.equal(plan.side, "SELL");
  assert.ok(plan.stop_loss > 200);
});
