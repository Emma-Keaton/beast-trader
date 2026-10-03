# Trade history and training data

Everything the app observes is written to Supabase and survives a container
restart. Nothing that matters is held only in memory or on disk.

## The two ledgers

| Table | What it records | Used for |
|---|---|---|
| `paper_calls` | Every **prediction**: direction, confidence, feature vector, then the price it actually reached. | Training, model scoring, the "did we beat just holding?" control. |
| `orders` | Every **executed trade**: side, size, fill price, stop, target, then the exit and net P&L. | Display, audit, and training. |

Both modes are recorded with a `mode` column (`paper` / `live`). Nothing is
split across two systems.

## Why orders are a training source

An order used to be a display row written once and never touched — no exit, no
P&L, nothing to learn from. So the trades the app *actually placed*, at the
sizes it computed and the prices it filled at, never reached training. The model
learned only from paper calls, which are a rehearsal of the decision rather than
the decision itself.

Now:

- `planOrder()` copies `probability` and the `features` vector onto the order at
  **decision time**, before the outcome is known — the only version of the
  vector worth learning from.
- `settleOrders()` marks each filled order to market after the horizon, computes
  net return after the same 0.1% taker fee the paper ledger charges, and writes
  `exit_price`, `pnl_pct`, `pnl_usd`, `settled_at`.
- `normaliseOrders()` (in `ml/retrain.js`) reshapes settled orders into the form
  the retrainer already consumes; `improve.js` merges them with the paper calls.

Same fee and same 3-hour horizon on both paths, so an order and a paper call are
measured on identical terms and can share one training set.

### The safety rule that matters most

`settleOrders()` **never marks a `queued_live` order.** Those are parked pending
exchange connectors — no fill, no position. Marking one would invent a trade that
was never sent. A test pins this.

### Sizing is recorded, not applied

`notional_usd` on a paper order is the size the model *would* have used, from
continuous probability sizing in `ml/sizing.js`. It is never sent anywhere. Live
orders stay parked at `status: 'queued_live'` until connectors exist.

## Reading the data

```sql
-- every trade, both modes, newest first
select created_at, mode, symbol, side, qty, filled_price, exit_price, pnl_usd, status
from orders order by created_at desc limit 50;

-- realised performance, by mode
select mode, count(*) as trades, avg(pnl_pct) as avg_return, sum(pnl_usd) as total_usd
from orders where status = 'settled' group by mode;

-- how much of the paper ledger is actually trainable
select
  count(*) filter (where status = 'settled') as settled,
  count(*) filter (where status = 'settled' and features is not null) as trainable
from paper_calls;

-- settled orders that carry a feature vector
select count(*) from orders
where status = 'settled' and settled_at is not null and features is not null;
```

That last query is the one to watch. It should climb over the first week; if it
stays 0 while `orders` grows, either no model is promoted (so nothing trades) or
`planOrder` is not receiving features.

## A note on mixing the two sources

Settled calls and settled orders are merged, **not** deduplicated. A call and an
order for the same symbol in the same window are two independent samples of the
same decision process; collapsing them would bias the training set toward
whatever the autopilot happened to trade. `normaliseOrders` tags each row with
`source: 'order'` so provenance stays auditable, and
`/api/improvement/progress` reports `fromOrders` separately.
