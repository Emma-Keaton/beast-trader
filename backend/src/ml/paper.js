/**
 * Paper trading ledger.
 *
 * Backtests tell you how a model behaved on the past. They cannot tell you
 * how *this* deployment behaves on *live* prices, which is the only number
 * worth showing a user. This module records every real prediction the poller
 * makes, then settles each one once its horizon has elapsed, producing a
 * live track record: how many calls were right, what buy-and-hold would have
 * done over the same window, and what the equity curve looks like.
 *
 * Nothing here touches an exchange or moves money. It is the rehearsal.
 *
 * Storage reuses the `orders`-shaped collections so no schema change is
 * needed: an open call is a row with `status: "open"`, settled rows carry the
 * realised outcome.
 */

import { insertRow, listCollection, updateRow } from "../store.js";
import { feedOutcomes } from "./breakersvc.js";

/**
 * The two horizons in this app, and why both are legitimate.
 *
 * The app runs two kinds of model and they answer different questions, so they
 * had different settlement windows — which was previously an accident (a comment
 * claiming "3 bars at 1h" when the bars are daily) and made the paper ledger
 * internally inconsistent. It is now an explicit registry, which means the
 * difference is stated in one place and cannot drift silently again.
 *
 *   ENTRY (3d)    - "will this be worth entering in the next few days".
 *                   Trained on `dataset.js` labels at horizon 3. This is a
 *                   tactical question and 3 days is the right window for it.
 *   STRATEGIC (14d) - "is this coin in a trend worth holding".
 *                    `forecast.js` measures this, and the research pass is
 *                    unambiguous that it is a coin flip at 3-7 days and only
 *                    becomes measurable at 2-4 weeks.
 *
 * They are scored on separate ledgers and must never be pooled: a model that is
 * right about "buy this week" tells you nothing about "this is a holder", and
 * averaging their hit rates produces a number that describes neither.
 *
 * `DAYS` is what actually settles rows. `resolveHorizonDays` picks the window
 * for a given basis so no caller re-derives it.
 */
export const HORIZONS = {
  /** Logistic/feature model: `dataset.js` label horizon. Tactical timing. */
  ENTRY: { bars: 3, ms: 3 * 24 * 3600_000, kind: "entry" },
  /** Ensemble price-path model: `STRATEGIC_HORIZON`. Position sizing. */
  STRATEGIC: { bars: 14, ms: 14 * 24 * 3600_000, kind: "strategic" },
};

/** Which horizon a prediction should settle on. Unknown bases default to ENTRY. */
export function resolveHorizonDays(basis) {
  return basis === "ensemble" ? HORIZONS.STRATEGIC.bars : HORIZONS.ENTRY.bars;
}

/** Settlement window in ms for a given basis. */
export function resolveHorizonMs(basis) {
  return basis === "ensemble" ? HORIZONS.STRATEGIC.ms : HORIZONS.ENTRY.ms;
}

/**
 * Record a new prediction to be settled later.
 *
 * The feature vector is stored *with* the call, and that is the whole point:
 * a settled call then becomes a training example built from the app's own
 * forward-looking, fee-bearing, real-time outcome. Nothing else in the system
 * produces data quite like that — not history (which is what the model already
 * learned from) and not a backtest (which is free of real fills).
 *
 * Without the vector, the paper ledger is a scoreboard. With it, it is the
 * highest-quality training set the app will ever own, and the retrainer in
 * `retrain.js` works from it directly.
 */
export async function openCall(deviceId, snapshot, prediction) {
  if (!prediction || prediction.signal === "HOLD") return null;
  if (!snapshot.price_usd) return null;
  return insertRow("paper_calls", {
    device_id: deviceId,
    symbol: snapshot.symbol,
    side: prediction.signal,
    entry_price: snapshot.price_usd,
    confidence: prediction.confidence,
    // The calibrated P(up) the call was made on, so a settled call can be
    // scored for calibration as well as direction.
    probability: prediction.probability ?? null,
    model: prediction.model,
    // The feature vector at prediction time — the label's input, captured
    // before the outcome is known.
    features: Array.isArray(prediction.features) ? prediction.features : null,
    opened_at: new Date().toISOString(),
    due_at: new Date(Date.now() + resolveHorizonMs(prediction.basis)).toISOString(),
    // Stamped on the row so a settled call can always be traced back to the
    // window it was scored over. Without it, the two horizons become
    // indistinguishable after the fact and the ledger cannot be audited.
    horizon_days: resolveHorizonDays(prediction.basis),
    status: "open",
  });
}

/**
 * Settle every matured call for a device using the current price.
 * @param pricesFn `(symbol) => number|null` — usually the live quote
 * @returns the number of calls settled this run
 */
export async function settleMatured(deviceId, pricesFn) {
  const calls = await listCollection("paper_calls", deviceId, "created_at.desc");
  const now = Date.now();
  let settled = 0;

  for (const c of calls) {
    if (c.status !== "open" || !c.due_at) continue;
    if (new Date(c.due_at).getTime() > now) continue;

    const exit = await pricesFn(c.symbol);
    if (!exit) continue; // no price yet — try again next tick

    const dir = c.side === "LONG" ? 1 : -1;
    // Same 0.1% taker fee a real venue would charge, so the live ledger
    // and the backtest are measured on identical terms.
    const gross = dir * (exit / c.entry_price - 1);
    const net = gross - 0.002;
    // The control is "just hold this coin", which is always a long and pays
    // the same round-trip fee. Comparing against a same-direction trade
    // would make "beat the market" true by construction.
    const bh = c.entry_price ? exit / c.entry_price - 1 - 0.002 : 0;

    c.status = "settled";
    c.exit_price = exit;
    c.return_pct = Number(net.toFixed(6));
    c.buy_hold_pct = Number(bh.toFixed(6));
    c.beaten_market = net > bh;
    c.won = net > 0;
    c.settled_at = new Date().toISOString();

    // Persist the outcome. Without this the mutation above is throwaway against
    // Supabase (the rows came back from an HTTP response, not by reference), the
    // call stays "open" forever, and the retrainer never sees a single settled
    // row — the learning loop would look alive and learn nothing.
    try {
      await updateRow("paper_calls", c.id, {
        status: "settled",
        exit_price: exit,
        return_pct: c.return_pct,
        buy_hold_pct: c.buy_hold_pct,
        beaten_market: c.beaten_market,
        won: c.won,
        settled_at: c.settled_at,
      });
      /**
       * Feed the safety breaker. This is the only place in the app where reality
       * gets a chance to overrule the static gates.
       *
       * Every other control runs *before* an order and assumes the model is good.
       * This one runs after settlement, which is the only moment where the
       * assumption can be tested. Without it the breaker sits closed forever and
       * a strategy that fails on live prices is halted by nothing.
       *
       * Paper and live are treated identically on purpose: the question is
       * whether the *strategy* is wrong, and simulated money answers that exactly
       * as well as real money does.
       */
      feedOutcomes([{ pnl: net, at: c.settled_at }]);
      settled++;
    } catch (err) {
      // One failed write must not abort the whole sweep; the call stays open
      // and is retried on the next tick.
      console.warn("[paper] settle persist failed:", err.message);
    }
  }
  return settled;
}

/** Live track record for the UI. */
export async function paperStats(deviceId) {
  const calls = await listCollection("paper_calls", deviceId, "created_at.desc");
  const settled = calls.filter((c) => c.status === "settled");
  const open = calls.length - settled.length;

  if (!settled.length) {
    return { open, settled: 0, winRate: null, beatMarket: null, totalReturn: 0, marketReturn: 0, avgReturn: null };
  }
  const wins = settled.filter((c) => c.won).length;
  const beat = settled.filter((c) => c.beaten_market).length;
  const sum = (k) => settled.reduce((s, c) => s + (c[k] ?? 0), 0);
  return {
    open,
    settled: settled.length,
    winRate: wins / settled.length,
    beatMarket: beat / settled.length,
    totalReturn: sum("return_pct"),
    marketReturn: sum("buy_hold_pct"),
    avgReturn: sum("return_pct") / settled.length,
  };
}
