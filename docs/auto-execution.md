# Auto-executors and live trading safety

How the app decides to trade, what stops it, and what still blocks live mode.

---

## The auto-executor

Watches each chain's top performers and acts when a candidate clears that
chain's thresholds. Runs every **10 minutes** (`AUTOEXEC_INTERVAL_MS`), not on
the 30-second market poller: a sweep across eight chains costs real API quota,
and a candidate worth buying now is usually still worth buying in ten minutes.

```
GET  /api/autoexec          → every chain's limits and breaker state (public)
POST /api/autoexec/run      → force one sweep now (authenticated)
GET  /api/live/readiness    → the checklist gating the live switch (authenticated)
GET  /api/models/board      → every model's live record, ranked (public)
```

### Per-chain limits

Published by `/api/autoexec` so the UI can explain *why* a chain is not trading
rather than showing a silent no-op.

| Chain | Min liquidity | Min confidence | Max order | Drawdown halt | Loss streak halt |
|---|---|---|---|---|---|
| Major exchange (CEX) | $500k | 65% | $100 | 15% | 6 |
| Solana | $100k | 75% | $25 | 25% | 4 |
| Base / Arbitrum / Polygon | $150k | 75% | $20 | 25% | 4 |
| BNB Chain | $200k | 75% | $20 | 25% | 4 |
| Ethereum | $500k | 78% | $25 | 25% | 4 |
| Avalanche | $120k | 75% | $20 | 25% | 4 |

**Why DEX is held to a stricter bar.** A confidence score measures one thing:
how sure the model is about direction. It says nothing about whether the trade
can be entered and exited. Long-tail pools carry risks a spot pair on a major
exchange does not:

- **Liquidity can vanish.** A $30k pool can be drained in one transaction, and
  by the time a stop-loss would have fired there is nothing left to sell.
- **Slippage is unbounded when it matters.** The quoted price is for a tiny
  order. Yours is not a tiny order.
- **The contract can be malicious** — a honeypot, a transfer tax, a mint
  function one wallet controls. None of that is visible in a price chart.
- **There is no recourse.** A major exchange will reverse an erroneous fill. A
  DEX has no customer service.

So the floor is set by the **venue**, not the model. A 99%-confidence signal on
a $4k pool is still refused — there is a test pinning exactly that.

**Missing liquidity counts as unknown, not as fine.** Absence of data must never
read as permission.

### Order of checks

Venue screening runs **before** the confidence check. A model being 95% sure
about a $4,000 pool is still wrong to trade, and there is no point spending
reasoning on a candidate that was never viable.

---

## The trade gate

One chokepoint every order must pass — poller, auto-executor, and manual trades
alike. Adapted from `trade_gate.py` in `jasper-trades`, whose key property is
that it is a *single* function returning **named checks with reasons**, not a
bare boolean. With a poller, an auto-executor and a manual button in one app,
per-route checks drift apart, and whichever route is weakest becomes the way in.

```
1. circuit breaker open?      — the kill switch
2. side / amount / symbol sane
3. mode is live                — paper is the default
4. a connected exchange
5. the model is promoted       — no unproven model trades on its own
6. per-order cap, exposure cap, daily loss cap, minimum size
```

Every check returns `{ name, passed, detail }` and the full set is returned even
on success, so the UI can show what passed.

### A real bug this found

`maybeAutoTrade` in `executor.js` called `executeOrder` **directly**, bypassing
the gate entirely. It checked model promotion and a confidence threshold, but
**not** the circuit breaker, the per-order cap, exposure, or the daily loss
limit — and it ran from the poller, unattended, every 30 seconds. That was the
weakest link in the whole safety chain. It now routes through
`checkPrerequisites` like every other path.

---

## The circuit breaker

Global kill switch, plus **one per chain**.

A single global breaker is not enough. A Solana memecoin executor and a Bitcoin
spot executor are not the same risk, and a losing day in one says nothing about
the other. With one breaker, the first chain to trip halts *everything* — which
teaches the wrong lesson (the *system* is broken) when the truth is that one
*strategy* on one venue of long-tail tokens is broken.

Per-chain breakers keep the blast radius small and let the surviving chains keep
earning evidence.

Trips on: drawdown from the high-water mark, a run of consecutive losses, stale
price data, or a manual halt.

Two properties that are easy to get wrong, both pinned by tests:

- **Resuming keeps the peak.** Resetting it would erase the drawdown that caused
  the halt, and the identical loss would be allowed to happen again immediately.
- **The breaker never resumes itself.** Even on a great equity update. Resuming
  is a human decision, every time.

A chain's breaker can be *more* restrictive than the global one, never less — an
override can stop trading but never re-enable it. Also pinned by a test.

---

## Exchange connectivity (CCXT)

56MB, 104 exchanges, loaded **lazily** so a 56MB import never lands on every
cold start. Shortlisted to six: Binance, Bybit, Coinbase, Kraken, KuCoin, OKX.

**`sandbox` defaults to `true`.** A real exchange "sandbox" silently pointed at
production is a classic failure, so live trading must opt in explicitly.

### There is no withdrawal path

`services/exchange.js` can **place** orders. It cannot **withdraw**. There is no
withdrawal method, no withdrawal path, and no code path that could be coaxed
into one. That is a design constraint, not an oversight: withdrawal is a
different operation from trading with entirely different consequences, and a
trading key that can also withdraw can be drained.

> **Create API keys with withdrawals disabled.** IP-restrict them to Render's
> egress. Use spot only. See `docs/deploy-runbook.md` for per-exchange URLs.

Credentials are decrypted per request, never cached, never logged, never in an
API response. A balance check returns **asset names only**, never amounts.

---

## What still blocks live trading

`GET /api/live/readiness` returns the checklist. On a fresh device:

```json
{ "ready": false, "failures": [
  { "name": "model_promoted",     "detail": "no model has passed the validation gate yet" },
  { "name": "exchange_connected", "detail": "connect an exchange in Settings first" },
  { "name": "limits_configured",  "detail": "set your risk limits so orders stay inside them" }]}
```

Three independent gates, all of which must open:

1. `TRADING_MODE=live` per device — and even then `executeOrder` **parks** the
   order as `queued_live` unless a connector is explicitly wired.
2. The model must be **promoted**. It is not: *"Not accurate enough (51% right —
   needs 53%)"* and *"Its edge could be luck rather than skill."*
3. Every trade-gate check passes.

Switching **back** to paper is always allowed. A user must never be locked out of
reducing their own risk.

---

## The honest state of the models

The forecasting ensemble was validated walk-forward over the app's own cached
17-coin history (2,346 points):

```
overall              49.5% hit,  Brier 0.273
confidence >= 0.20   46.3% hit,  Brier 0.349
confidence >= 0.40   44.2% hit,  Brier 0.443
```

**Confidence is anti-correlated with accuracy.** The more sure it is, the worse
it does. That is the opposite of what a confidence score should mean, and it is
the single most important finding in this work.

The ensemble therefore **runs, records, and gets scored — but is not wired into
the trading decision.** It earns its place on evidence like any other model,
through `GET /api/models/board`. `edge` there is signed: negative means worse
than a coin flip.

Brier is the primary scoreboard metric rather than hit rate, because hit rate
rewards a model that is right 55% of the time while claiming 90% confidence.
Only Brier catches that, and there is a test for it.
