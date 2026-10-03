# Strategy research — what the reference repos actually offer

Reviewed 20 repositories in `E:\Projects\finance-repos` (all updated, all clean at
time of review). This records what was worth taking, what was rejected, and why.

## Adopted

### purgedcv (eslazarev/purged-cross-validation) — MIT
The reference implementation of López de Prado's machinery. The app already had
PSR/DSR/CPCV in `src/ml/stats.js` and `src/ml/purged.js`; this confirmed the
formulas and supplied the one piece that was missing — `effective_n_trials`,
which discounts correlated trial series. **Kept the existing hand-rolled version**
rather than adding a Python dependency: Render's free tier runs Node, and a
subprocess call per retrain would be both slower and a new failure mode.

The valuable idea from it that is *not* yet in the app: sequential search
(TPE/CMA-ES style) inflates the trial count, and `n / (1 + 2·Σρ)` corrects it.
`effectiveTrials` in `stats.js` is the correlation-based equivalent.

### RD-Agent (microsoft/RD-Agent) — MIT
`rdagent/components/workflow/rd_loop.py` is the clearest statement of the
propose → develop → run → summarise loop this app now implements in
`ml/retrain.js` + `ml/strategies.js`. The architectural borrow is that the
**loop proposes and a separate gate decides** — RD-Agent keeps coder, runner and
feedback as distinct roles, which is why a bad iteration cannot overwrite a good
result. That is the same champion/challenger split, arrived at independently.

One thing deliberately *not* taken: RD-Agent's LLM writes the factor code. An
LLM-authored strategy entering a money-moving path is unauditable, and its
"improvements" are selected by the same backtest that generated them.

### FinRL — MIT
The turbulence index (Mahalanobis distance of recent returns against the
historical distribution) is a genuine macro risk overlay and is the one part of
FinRL worth porting: it is a few lines of linear algebra, needs no RL stack, and
maps onto a "flat when the regime is unlike anything in the sample" rule. Not
implemented yet — listed below.

### qlib (microsoft/qlib) — MIT
Its data-leakage checks (label availability vs. feature availability at every
timestamp) are the discipline this app's purging already implements. Confirmed
the walk-forward + purge approach rather than replacing it.

## Considered and rejected

| Repo | Why not |
|---|---|
| **Kronos** | A candlestick foundation model (102M params). It is the strongest *model* in the set, but it needs Python + torch + a GPU-class box. Render's free tier has 512MB RAM. Also equity/A-share trained. |
| **freqtrade / FreqAI** | Excellent, but LightGBM/XGBoost + a Python runtime. Same blocker. Its lookahead-analysis tooling is the one idea worth keeping, and is a rule, not a dependency. |
| **hummingbot** | Cython; the market-making engine is far beyond this app's scope and its connectors are Python. |
| **nautilus_trader** | Rust core. Right tool for latency-sensitive execution; wrong for a 30s-polling paper-trading app on a free tier. |
| **Artemis / simple-arbitrage** | Solidity MEV. Requires an RPC node, bundle relays and gas capital. Genuinely out of scope. |
| **vectorbt / backtrader** | Python. Their *metrics* were used as a cross-check for `stats.js` (the file header records this), which is the right level of engagement. |
| **lumibot / AI-Trader / tradingagents / Vibe-Trading / quantdinger** | LLM-agent wrappers around a Python backtester. Same dependency problem, and the LLM-in-the-loop concern above applies with more force. |

## The uncomfortable finding

A 16-configuration sweep (horizon × confidence threshold) on the 14-coin universe
produced this:

```
h=2 mc=0.3  perTrade=7.892%  acc=51.9%  dsr=0.000  trades=13
h=3 mc=0.3  perTrade=4.497%  acc=50.9%  dsr=0.000
h=3 mc=0.2  perTrade=2.735%  acc=50.9%  dsr=0.986
```

The best-looking configuration in the entire sweep is **+7.9% per trade at a
100% win rate — on 13 trades.** It is noise, and it is exactly the kind of result
that gets shipped by a system that reports expectancy without a sample-size
floor.

`backtestXs.significanceOf` already refused it (`insufficient_sample: true`,
below the 200-trade floor), and `train.js` now prints the warning explicitly. But
the deeper point stands: **per-trade expectancy is not a measure of edge.** The
deflated Sharpe and the trade count are. The headline numbers should be read
together or not at all.

## What the P&L numbers are worth

After fixing basket compounding (see `tests/xsBasket.test.js`), the headline run
went from an impossible "+1.9% per trade with 99.4% drawdown" to a *coherent*
"+2.1% per trade, 63.7% win, 49.6% max drawdown over 153 bars."

Coherent is not the same as correct. A 50.8% accuracy model — statistically
indistinguishable from a coin flip — is being asked to produce 63.7% win rates on
its confident subset. Two readings are possible and the current evidence cannot
separate them:

1. The confidence filter genuinely selects a better subpopulation, and the edge
   is real but small.
2. The `noiseMult` filter (rows below half the typical bar move are dropped) is
   doing the work, and the model is only ever scored on days that already moved.

Testing that properly means scoring the model on the *unfiltered* stream, where
it must also predict the small undecidable days. A first pass at this did not
settle it (unfiltered scoring gave a similar per-trade figure, but the
comparison was not clean enough to trust).

**Therefore: not promoted, and should not be.** The correct next step is a
strictly walk-forward evaluation on unfiltered data with the trade count
reported alongside every expectancy figure.

---

## Addendum: signal research over the full cached history

Ran `node backend/scripts/research.js` over `backend/data/history`: 14 coins after
dedupe (BTC, ETH, LTC, ADA, XRP, LINK, DOGE, SOL, DOT, UNI, AVAX, NEAR, PUMP, NIGHT),
3,332 aligned **daily** bars = 9.1 years, 2017-2026.

Note: the app's own history is daily too (`history.js` requests `interval=daily` and
`interval=1d`), so this is the right timeframe. It is the wrong *universe* - these are
large caps, and the app trades Solana long-tail. Treat as evidence about crypto, not
proof about that venue.

### What is predictable

| thing | strength | verdict |
|---|---|---|
| **Volatility** | IC **0.187** (1d->1d), 0.110 (1d->7d) | Far and away the strongest signal in the data. Real and usable. |
| **Trend distance (dev20) at 7d** | net **+0.73%**/trade, **t=+3.0** | Best time-series result measured. |
| **Trend distance at 30d** | net **+2.90%**, t=+2.0 | Also real. |
| 30-day momentum at 30d | net +2.81%, t=+2.0 | Consistent with the above, not independent of it. |
| Everything at 1-3 days | 47-52% hit | Noise. mom1 at h=1d is **47.2%** - *worse* than a coin flip. |

### The horizon is the whole problem

Does a big deviation from the 20-day mean continue, or reverse?

| |dev20| | continues at h=7d | continues at h=30d |
|---|---|---|
| 0-0.5 sigma | 0.511 | 0.509 |
| 0.5-1 sigma | 0.509 | 0.508 |
| 1-2 sigma | 0.494 | 0.530 |
| 2+ sigma | 0.499 | **0.564** |

The trend edge only **materialises over ~2-4 weeks**. At 7 days it is a coin flip at every
bucket. The app forecasts `horizon: 3` - **three days**. It is asking a question three to
ten times too early, which is exactly how you get a confident model that is wrong: the
pattern it is keyed on has not had time to appear, so what it is actually reacting to is
noise.

### The mean-reversion member is fighting the data

Deviations **continue** (0.564 at 2+ sigma over 30d), they do not revert. The ensemble
includes a mean-reversion model, so roughly a third of its vote is systematically opposed
to what the 9-year record says crypto does. That is a concrete fix, not a tuning problem.

### The app's premise does not beat just holding everything

Long the top-N coins by trailing return vs equal-weighting the whole board:

| lookback | hold | N | net | benchmark | net minus bench | t |
|---|---|---|---|---|---|---|
| 7d | 7d | 2 | +1.44% | +1.64% | **-0.20%** | -0.5 |
| 30d | 14d | 3 | +3.88% | +3.41% | +0.48% | +0.7 |
| 30d | 30d | 3 | +8.14% | +8.14% | +0.00% | +0.0 |

Gross returns look attractive (8% a month) but the whole board did 8.14%. Excess is
**0.0-0.5% with t-stats of 0.0-0.7** - statistically indistinguishable from buying
everything. On large caps, "buy the top gainers" is **beta, not alpha**, and the app is
charging itself 34bps a round trip for it.

### Consequences

1. Lengthen the strategic horizon to 14-30 days; keep the short one for entry timing only.
2. Drop or invert the mean-reversion member.
3. Add a volatility model - it is the only high-confidence predictor available, and it is
   useful for sizing and for declining to trade, without needing any directional skill.
4. Score **excess over equal-weight-hold**, not hit rate vs a coin flip. Hit rate cannot
   tell a strategy from beta; this is the metric that does.

---

## Model changes from the research (2026-10)

Implemented, all driven by the measurements above rather than by tuning toward a
target number. 229/229 unit tests pass (22 new, in `backend/tests/edge.test.js`).

### What changed

**Horizon: 3 bars -> `STRATEGIC_HORIZON = 14`** (`src/ml/forecast.js`).
The single largest lever. The signal needs 2-4 weeks to express; it was being
asked about three days.

**Mean-reversion demoted to a non-voting observer.** It was fitted with a fixed
weight of 0.5 and no evidence behind it, betting against nine years of data. It
is still fitted and still reported (`reversionZ`) because disagreement is
information, but its weight now defaults to **0** and must be raised explicitly
by a caller who has evidence for it.

**New member: trend-distance** (`fitTrendDistance`). Carries the vote with the
sign the data supports — continuation, not exhaustion. Weighted by `|z|` so it
contributes nothing near the mean rather than a confident shrug.

**New: `forecastVolatility()`.** EWMA of squared log returns. Volatility was
the only strongly predictable quantity in the study (rank IC 0.187, ~6x the best
directional signal), and it needs no directional skill to exploit.

**New: the cost wall.** `forecast().tradable` is false when the expected move
over the horizon does not exceed round-trip cost by a margin. `toPrediction`
then forces HOLD and says why. On long-tail Solana this is often the binding
constraint, and it needs no model at all.

**New: `calibrateConfidence()`.** Confidence is now an obligation, not a
claim: given past calls at each conviction level, what fraction were right?
A model that was right 45% of the time when "confident" now scores near zero.
Returns `null` below 30 settled calls, and `confidenceCalibrated: false` says
so explicitly, so unknown is never rendered as high.

**New: Kelly and vol-targeted sizing** (`src/ml/sizing.js`). `kellySize()` =
quarter-Kelly x vol-targeting x hard cap. Quarter-Kelly because every
probability here is an estimate and full Kelly is unforgiving of an inflated
one; vol-targeting because vol is the thing we can actually forecast.

**Fixed: the horizon lie.** `toPrediction` omitted `horizon` entirely, so the
ensemble inherited no label at all. It now reports `14d` and cannot be confused
with the logistic model's `24h`.

### One thing to be suspicious of

Run against the real cached history, the ensemble returns **LONG on 17 of 17
coins, zero SHORT**. Investigated: this is not a sign bug. Every coin currently
sits above its own 20-day mean (z from +0.43 to +2.86), so the continuation
signal is correctly saying long in a market that is uniformly extended.

But it is precisely the beta trap identified above, seen from the inside. A signal
that is long on everything in a bull market has demonstrated nothing. Until the
scoreboard has settled calls from a *down* market, the high `probUp` values
(0.69-0.91) carry no information about skill. That is what the calibration and
the scoreboard exist to settle, and it will take real elapsed time, not a
parameter change, to settle.

---

## Wiring plan: paper trading + training (2026-10)

231/231 tests pass. Everything below is derived from reading the actual call
graph, not from assuming a component exists because a file with that name exists.

### The bug that blocked everything

Two constants encoded the forecast horizon independently, and **both were wrong by
the same factor**:

| file | constant | was | now |
|---|---|---|---|
| `src/ml/paper.js` | `HORIZON_MS` | 3h | 14d |
| `src/services/executor.js` | `ORDER_HORIZON_MS` | 3h | 14d |

Both carried the comment "3 bars at 1h bars". The bars are **daily**
(`snapshot.js` pulls 120 daily bars from `fetchDailyBars`), so a bar is a day.
Every paper call was being settled three hours after being made and scored as
though it had tested a 14-day thesis. Left in place, the app would have recorded
a few thousand settled calls, found every model scoring at coin flip, and
concluded - wrongly and permanently - that none of them work.

Both are now pinned by one test that reads all three horizon constants and
requires agreement.

### Already wired (no work needed)

- **Poll loop** - `startPoller()` every 30s: predict, `openCall`,
  `settleMatured`, `recordSignal` for both primary and ensemble. Runs at boot.
- **Improvement loop** - every 6h: `retrain()` builds challengers from settled
  calls, scores them on identical calls, promotes only past deflated Sharpe 0.95.
- **Auto-exec loop** - every 10min: screens candidates on venue risk first, then
  model confidence, then the trade gate. Defaults to `intent: "paper"`.
- **Paper execution** - `executeOrder` books simulated fills at market.
- **Promotion gate** - `canAutoTrade()` requires `promoted === true`.
- **Live refusal** - `executor.js:82` parks live orders as `queued_live`.
  No live connector exists. Good: nothing can accidentally go live.
- **Store** - Supabase if configured, else local JSON.

### Blocked until config

1. **No trained model exists** - `data/model.json` is absent. `canAutoTrade()`
   is therefore false and auto-exec cannot act. Must run `runImprovementCycle`
   after enough settled calls.
2. **Supabase not configured** - falling back to local JSON, so nothing persists
   across redeploys on Render. Set `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`
   or the paper track record resets every deploy.
3. **Poller needs a device** - a watchlist with symbols, else there is nothing to
   record calls on.

### Timings you should expect

- First settled call: **14 days** (was 3 hours).
- `MIN_ROWS = 40` calls before improvement can run.
- `MIN_SETTLED_FOR_RETRAIN = 60`.
- `minTrackDays: 3`, `minSettledCalls: 30`, `minDeflatedSharpe: 0.95`.

At one call per symbol per 30s poll that is fast to *collect*, but the 14-day
settlement window means **nothing is measurable for two weeks**. That is correct
and unavoidable: it is the time the signal needs. Any tuning done before then is
fitting noise.

### Known remaining gap

`dataset.js` labels with `horizon = 3` and `improve.js` tracks
`TARGET_DAYS = 7`. Both are the logistic model's own short-horizon targets and
are internally consistent with each other - they are **not** the ensemble's
14-day thesis, and they should not be. Two horizons in one app is legitimate
(entry timing vs strategic). But it must be a decision on the record, not an
accident, because the ensemble and the logistic model cannot be scored against
each other on the scoreboard if they settle at different times.

---

## Live trading: wired, with three independent locks (2026-10)

235/235 backend tests pass; `tsc --noEmit` clean. Full notes in the file itself.

### The connectors already existed

`exchange.js` has signed Binance/Coinbase clients, `placeOrder` with
symbol/amount/price/step-size validation, testnet support and HMAC signing. What
was missing is that **nothing called it**: `executeOrder` returned early with
`status: queued_live` and a note saying connectors were "pending". They were not
pending - they had been written and simply never wired in. That gap is closed.

### A real safety hole, found while wiring it

`PUT /settings` listed `trading_mode` in its writable whitelist. So
`{ "trading_mode": "live" }` wrote the mode straight to storage and **skipped
`liveReadiness()` entirely** - the one-way, hard-to-undo decision that
`setTradingMode()` exists to guard was reachable by one unguarded request.
`setTradingMode` was imported nowhere.

A confirmation modal does not fix this, because the endpoint is the trust
boundary and any client can call it. Fixed at the API: `trading_mode` removed
from the whitelist, a 409 pointing at the guarded path if a client tries, and a
dedicated `POST /trading-mode` route that is now the only way to go live.

### Three locks, each covering a different failure

1. `LIVE_TRADING_ENABLED=true` in the server environment. "May this deployment
   move money at all." Exact string only - `yes`, `1` and `TRUE ` all fail
   closed. Read per-call so it takes effect without a restart.
2. Per-device mode via the guarded route. "Has this user consented." Requires
   `confirm: true` server-side, so it cannot be skipped by a client rendering no
   dialog. Goes back to paper with no dialog, always - a user must never be locked
   out of reducing risk.
3. `canAutoTrade()` - a promoted model, earned on the scoreboard. Not a flag.

Mainnet is the default. `NETWORK=testnet` points the same connector at a sandbox code
opt-out, so it is a deliberate edit rather than a variable someone sets by
accident.

### The modal

`ConfirmModal` in `components/ui.tsx`: no backdrop-click, no Escape-to-confirm,
focus starts on Cancel, Tab is trapped, and it renders the live `readiness` check
list so the user sees exactly what would need to pass. The body states plainly
that the app has never demonstrated profitability and that the top-gainers strategy
returned the same as holding everything.

Four tests pin these properties, including one that reads the routes file and
fails if `trading_mode` reappears in the settings whitelist.

---

## Mainnet, wallets, retrieval, horizons (2026-10)

243/243 backend tests, lint 0, `tsc --noEmit` 0.

### Mainnet enabled

`LIVE_TRADING_ENABLED=true` and `NETWORK=mainnet` in a new gitignored `.env`.
`NETWORK=testnet` moves the same connector to a venue sandbox with no code edit.

This does not make live trading reachable on its own. Three other things must also
hold: per-device consent through the guarded route, a promoted model, and the
trade gate. Turning the flag on removes one of four locks, not three.

### Modal: X to close, and Escape cancels

`ConfirmModal` now has an explicit close button and Escape-cancels (previously
Escape did nothing, which meant "not yet" was reachable only by hunting for
Cancel). Both are dismissals, never confirmations. Cancel still holds initial
focus.

### Reverting to paper

A persistent red banner at the top of Settings whenever mode is live, with a
one-click **Back to practice**. No app-modal: a browser `confirm` guards against
misfire and then it happens immediately. Reducing your own risk is never gated
behind a second decision.

### Wallets: what is and is not buildable

This is the part of the request I could not simply wire, and the reason is
architectural rather than effort.

**CEX and wallet trading are different problems.** Binance trading is a server-side
REST call signed with an API key the app holds. Wallet trading (MetaMask, Phantom,
Solflare, Trust) keeps the private key in a browser extension: **the backend can
never sign a transaction.** There is no server-side connector to write, because
there is no server-side key.

Consequences, stated plainly:

- **Manual wallet trading is fully buildable.** Quote via Jupiter, hand the swap
  transaction to the browser extension, let the user sign. This is how every DEX
  frontend works and it needs no key material on the server.
- **Autonomous wallet trading is not.** It requires session keys (Solana) or a
  spending policy / ERC-4337 module (EVM) — a deliberate grant of bounded,
  revocable authority signed once by the user. That is a significant security
  design, not a connector, and shipping a fake version of it would be worse than
  not shipping it.

So "wire the auto-trader to my MetaMask" cannot be made true as stated. What can
be true is either:

  (a) **Assisted mode** — the auto-trader stages a trade, the wallet extension
      prompts the user to sign. Safe, deployable, honest.
  (b) **Session keys** — the user signs a bounded, revocable delegation once, then
      the auto-trader can act within it unattended. Real autonomy, real work.

For the Nigerian-use case you describe, note the venue list already supports
Kraken, Bybit, KuCoin and OKX via CCXT — all of which serve more regions than
Binance. **Changing `EXCHANGE_ID` gets you most of the accessibility win today**
with zero new code, and unlike a wallet it keeps the auto-trader fully autonomous.

Which of (a) or (b) do you want, if either?

### Local retrieval: built

`src/ml/retrieval.js` — BM25 over the project's own markdown. No API key, no
network, no data leaving the process, fully auditable (you can read exactly why a
document ranked where it did). Zero dependencies, consistent with the codebase.

Chosen over embeddings deliberately: the corpus is a few dozen documents and the
queries are keyword-shaped ("SOL", "14 day horizon", "spread cost"). Embeddings
are good at paraphrase and bad at exact identifier matching — the opposite of
what an asset lookup needs. Verified against the real docs: "volatility
predictability" and "mean reversion" both surface `strategy-research.md`.

`contextForAsset(symbol)` returns relevant passages for one asset, which is the
piece worth wiring into `/api/research`.

Two bugs the tests caught immediately: `path`/`fs` were never imported, and
`\` tokenised to `\` so it could never match a document saying "SOL" —
the single most common way a crypto note is written.

### The two horizons: resolved as a registry

`HORIZONS` in `paper.js` now names both windows and why they differ:

- `ENTRY` 3d — the logistic model's tactical question, matching its labels
- `STRATEGIC` 14d — the ensemble's trend question, matching `STRATEGIC_HORIZON`

Each call settles on the window its own model was fitted on, chosen by
`resolveHorizonMs(basis)`, and each row stamps `horizon_days` so the two
ledgers stay auditable. `executor.js` no longer holds its own copy of the
number — that independence is what let them drift in the first place, and a test
now fails if it becomes a literal again.

They are still never pooled: a model right about "buy this week" says nothing
about "this is a holder", and averaging them describes neither.

---

## Multi-venue, assisted mode, and what self-learning can honestly be (2026-10)

251/251 backend tests, lint 0.

### The bug that made connecting an exchange impossible

The settings route wrote flat fields (`binance_api_key`, `coinbase_api_key`).
`readCredentials()` has always read `settings.exchanges[exchangeId]`.

**So no exchange key typed into Settings has ever reached an exchange.** The UI
showed a saved key; the trading app could not trade with it. Every user who
connected a venue had a connected-looking UI and a non-functional trading path.

Fixed by accepting a venue-keyed object instead of a per-venue field list. That is
also what makes "connect whichever exchanges you like" possible: one shape covers
every venue in `SUPPORTED_EXCHANGES` (binance, bybit, coinbase, kraken, kucoin,
okx) and any future one, with no code change per exchange. Credentials merge
field-by-field, and a masked round trip (`••••saved`) can no longer wipe keys on
an unrelated save.

`GET /api/exchanges` publishes the list so the UI never hardcodes it again, and
`maskSettings` masks by shape — `{hasKey, hasSecret, hasPassphrase}` — so the
client can render "connected" but can never read a secret back.

`settings.exchange_id` selects the active venue. Multiple venues can be
connected at once; one is active.

### Assisted mode: designed and built (`src/services/assisted.js`)

The auto-trader decides *what*, *when* and *how much*. The user signs.

**The design rule: the app never holds key material and never decides to spend.**
It builds a proposal, shows exactly what it is, and waits. If the user walks away,
nothing happens. If the app is compromised, the attacker can propose trades the
user still sees and still refuses — but cannot sign one. The failure mode is
"nothing happened", not "money moved".

- `buildProposal` is **pure** — replayable, auditable, signs nothing.
- Proposals expire in 15 minutes. A forecast decays fast and the window bounds
  stale signable intents.
- The rationale shows **edge net of cost**, not a bare probability, next to what
  the trade costs. If they are close, it is not worth signing.
- **Declines are recorded outcomes**, not silent drops. How often a user declines,
  and on which signals, is real information about proposal quality.
- `shouldPropose` filters so the app asks *less*: expired, gate-refused, or
  below-cost proposals never reach the user. A user who signs everything is this
  mode's failure mode, so volume is the thing to minimise.

This is meaningfully weaker than autonomous CEX trading and the UI must not imply
otherwise. `describeMode` enforces that in one sentence per style.

Not yet built: the wallet signing layer itself (Phantom/Solflare Jupiter swaps,
MetaMask/Trust EVM). That is the next piece, and it is client-side by necessity.

### Self-learning: what already works, verified

The loop is real, not aspirational. Run against 200 synthetic settled calls:

`
trained: true | challenger: chal_muqejezr
promotion: false | "no challenger is eligible yet"
`

That is the correct outcome — it trained a challenger and **refused to promote it**
for lack of track record. The machinery already present:

- `improvementCycle` — retrain, propose challengers, score on identical calls
- purged / combinatorial-purged CV with embargo (`purged.js`) — prevents
  leakage between overlapping label windows, which is the usual reason a
  backtest flatters itself
- `evaluatePromotion` — deflated Sharpe >= 0.95, >= 30 settled calls,
  >= 3 track days, capped at 4 challengers
- every model scored against the same realised prices (`scoreboard.js`)

**The honest limit.** This learns to *refit* on your own history. It cannot make a
signal that has no edge into one that has. The research found the directional
signals sit at 47-56% — coin flips with variance. A self-improving loop pointed at
a coin flip converges on noise, which is why the deflated-Sharpe gate exists and
why promotion requires track days rather than just settled calls.

What genuinely improves with more data is **volatility** (rank IC 0.187) and
**cost-aware behaviour** (declining unprofitable trades) — both of which need no
directional skill. That is the honest ceiling to design against.

---

## Assisted mode wired end to end, and a readiness audit (2026-10)

251/251 backend tests, lint 0, `tsc --noEmit` 0. All new features verified against
real cached data, not mocks.

### What was completed

**Assisted mode end to end.** `autoexec.js` intercepts live orders when
`trade_style === "assisted"`: builds a proposal, runs it through `shouldPropose`,
and stops. No venue is contacted, no order is placed. Verified on real BTC history —
3,334 bars, 14-day horizon, 7.44% expected move, 7.10% net of the 34bps cost, proposal
staged as `pending_signature`.

**The gate learned about assisted mode.** `liveReadiness` used to demand exchange
API credentials unconditionally. In assisted mode that demanded exactly the thing the
mode exists to avoid: handing a long-lived trading key to a server. It now checks for
a configured wallet instead. This was a real design bug, not a missing feature.

**Routes:** `GET /exchanges`, `GET /proposals`, `POST /proposals/:id/decline`,
`POST /proposals/:id/signed`. Signing also books an `orders` row so a completed
assisted trade feeds `normaliseOrders` and becomes a training example — otherwise
the one trade the app actually made would be invisible to its own retrainer.

**Supabase:** `proposals` table plus a partial index on live rows only. Without it
every proposal write would fail in Supabase mode while working fine locally — the
worst kind of bug, since local testing would pass.

**Frontend:** venues fetched from the API instead of four hardcoded fields, active
venue selector, per-venue connect status, trade-style selector with honest one-line
descriptions. Credentials are masked by shape (`{hasKey, hasSecret, hasPassphrase}`),
so the client can show "connected" but can never read a secret back.

### Bugs found and fixed this session

1. **Exchange keys never reached any exchange.** UI wrote flat fields; the backend
   read `settings.exchanges[id]`. Every connected venue was decorative.
2. **Settings PUT bypassed the live gate.** `trading_mode` was writable directly.
3. **Paper settled in 3 hours what the model forecasts over 14 days** — in two files
   that were documented as needing to agree.
4. **`` could never match a document saying "SOL"** in the retrieval index.

Four bugs, all silent, all of the "looks like it works" variety. That is the pattern
worth naming: this codebase had no tests pinning horizon constants, credential shapes,
or the mode switch, so each of these was invisible until read closely.

### What is NOT built, and should not be pretended otherwise

- **Wallet signing layer.** Phantom/Solflare (Jupiter swaps), MetaMask/Trust (EVM).
  Client-side by necessity. The proposals inbox and sign/decline record are done; the
  extension handshake is not.
- **Session keys.** Real autonomy for wallets. A genuine security design, not a connector.
- **Enabling the routes in the UI.** The endpoints exist; the Settings page does not
  yet render a proposals inbox. Deliberate: a signing UI that cannot yet reach a
  wallet would show users prompts they cannot act on.

### Honest assessment of what is still missing for "fully ready"

Working and verified: multi-venue connect, three trade styles, proposal lifecycle,
horizon registry, local retrieval, a trained model, self-improvement loop, live
connectors, four safety locks.

Genuinely outstanding:

1. **The edge.** The trained model is 48-55% — a coin flip. Everything above is
   plumbing around a strategy that has not been shown to work. No amount of
   infrastructure changes this; only elapsed settled calls can.
2. **Wallet signing.** Needed for the "connect and walk away" vision.
3. **Proposals inbox UI.** Backend complete, frontend not wired.
4. **Long-tail data.** The research ran on large caps; the app trades Solana
   long-tail. Collect 30m history for the venue actually traded.
5. **Supabase configured.** Without it the paper record resets on every Render deploy —
   fatal for the 14-day measurement window.

### The one thing I would not build yet

Do not point this at mainnet. The flow will work; the strategy is unproven. The
cheapest useful next step is running paper for two weeks with a Supabase store and a
watchlist, then reading whether `beat the equal-weight benchmark` is positive. That
number decides everything else.

---

## Risk slider, and the readiness honesty fix (2026-10)

264/264 backend tests, lint 0, `tsc --noEmit` 0.

### First, the answer

**Proposals are not auto-approved.** They wait for a signature, and that is the
only point in the app where it stops. The other two styles are fully automated and
place no proposals at all:

- **paper** - auto-trades every 10 min, never leaves the machine
- **autonomous** - orders go straight out unattended, no human in the loop
- **assisted** - proposes, waits for a wallet signature

So the "everything automated" requirement is served by **autonomous**, which needs
no proposals and already works. Assisted is the optional manual path, and it exists
because a wallet key cannot be signed server-side. Full automation for wallets
requires session keys (Solana) or a spending policy / ERC-4337 module (EVM).

### Item 2: readiness could lie (fixed)

`liveReadiness()` never checked `LIVE_TRADING_ENABLED`. A device could be told
"ready, go live", confirm through the modal on the strength of a checklist that
said everything passed, and then have every order silently park as `queued_live`.
The readiness report must answer "will my trades actually go through", not a related
question. Now its own check, so it appears in the modal before you switch.

### Item 1: the risk slider

One continuous 0-100 control, three sectors, as specified. Every position inside a
sector produces distinct percentages; crossing a boundary promotes a tier.

The invariant that makes it a *risk* control rather than a size control: **size and
confidence move in opposite directions.** Bigger positions demand a *higher* bar. A
slider that raised size while lowering the confidence bar would not be bolder, it
would be incoherent - larger bets on weaker evidence. Tested across the whole range.

Verified continuous - largest single-step change in order cap anywhere on the slider
is **0 dollars**:

| position | sector | per trade | confidence | daily loss | positions | track |
|---|---|---|---|---|---|---|
| 0 | conservative | 25 | 72% | 10 | 1 | 21d |
| 33 | balanced | 50 | 50% | 25 | 3 | 14d |
| 66 | aggressive | 150 | 44% | 100 | 5 | 7d |
| 100 | aggressive | 500 | 38% | 400 | 8 | 1d |

Even at maximum aggression, a model needs at least one day of live record. Zero
would mean trading a model that has never traded.

The UI shows every consequence as a number, because "aggressive" alone means
nothing - the user is agreeing to 500 per trade at 38% confidence across 8
positions. The server resolves the mapping; the client never reimplements it.

### Two real bugs found while building it

**1. The slider did nothing at all.** `applyProfile` emits snake_case settings
keys (`max_order_usd`) while the gate's limits are camelCase (`maxOrderUsd`).
Spreading one into the other produced no effect: the slider looked wired, returned
plausible numbers to the UI, and changed no behaviour whatsoever. Now translated
explicitly at the single point where both shapes meet, with a test asserting the
gate's caps actually move.

**2. Sector boundaries were discontinuous.** The first version used one global range
per dimension and switched only the label, so the fractional position restarted from
zero inside each sector. Moving 32 to 33 dropped the order cap from 50 to about 13:
nudging the slider right made your risk fall. Ranges are now continuous across
boundaries, which is what makes `within` restarting at zero correct.

Both are the same failure mode as the earlier findings this session - a control that
appears to work and silently does nothing. There were no tests pinning the gate's
limit shape, so nothing caught it.

---

## Remaining build complete (2026-10)

284/284 backend tests, lint 0 on every file touched, `tsc --noEmit` 0.

### 1. Three orthogonal axes (done)

`src/services/capabilities.js`. `paper|autonomous|assisted` replaced by
`trading_mode` x `trade_authority` x `custody`. Eight combinations, all
classified, each described in one sentence so the UI never infers.

Every axis fails closed. Unknown `trading_mode` becomes `paper`; unknown
`trade_authority` becomes `approve` (never `auto` - that is the dangerous
value on that axis). Six tests, including that paper always wins regardless of
the other two, so a hand-edited settings row cannot route an order to a venue.

The dangerous cell is handled explicitly: `live + auto + wallet` **cannot sign**
today and is refused rather than silently downgraded, because "autonomous" with no
signing capability would mean the app appears to run while placing nothing.

### 2. Intraday collector (done)

`src/ml/intraday.js` + `npm run collect`. Twelve long-tail pairs at 15m,
idempotent by construction (keyed on open time), so it is safe to run for months.
Off by default behind `COLLECT_INTRADAY=true`.

Bugs caught by tests: `mergeBars` validated timestamps but not prices, so a NaN
close would have been stored as `{c: null}` and propagated into every
downstream volatility estimate.

### 3. Proposals inbox (done)

`/proposals` page. Shows the whole case for each trade including the part that
argues against it - expected move, cost, and what is left over - and says plainly
when the edge is thin. Decline works and is recorded. Refreshes every 60s so a
lapsed proposal does not sit there looking actionable.

The sign button is visibly disabled, not a dead control that looks broken: the
extension handshake does not exist yet.

### 4. Solana swap quoting (done, with a stated boundary)

`src/services/solana.js` + `POST /api/wallet/swap`. Jupiter quoting and unsigned
transaction building. **No signing, no key material, ever.** A test asserts the
returned object contains no `privateKey`, `secretKey` or `signer` field -
if that assertion ever fails, the server has become a custodian and the design
premise is false.

Quotes deeper than 300bps price impact are refused rather than proposed. On
long-tail Solana, depth - not direction - is the binding constraint.

### 5. Deploy config (done)

`docs/deploy.md`. Supabase schema must be applied before the backend starts, and
the service-role key is server-only. Leads with why `SUPABASE_URL` is not
optional: without it the store is local JSON and the 14-day record resets on every
redeploy, which makes the measurement the app exists to perform impossible.

### Not built, and why

**Client-side wallet signing.** The server half is done; handing a base64
transaction to a browser extension cannot be tested without an extension, and a
signing UI that cannot reach a wallet shows users prompts they cannot act on.

**Session keys.** Solana has had native ones for years and they are a far smaller
lift than ERC-4337. Deliberately deferred: unattended execution of a 48-55%
strategy buys nothing. Build it when there is an edge to execute.

### Honest status

The pipeline is complete end to end: multi-venue, three axes, risk slider,
proposals, collectors, connectors, self-improvement, 284 tests.

The strategy is still a coin flip. Every one of these is plumbing around a system
that has not shown it can make money. The only thing that changes that is elapsed
settled calls at the 14-day horizon, and `docs/deploy.md` ends with the checklist
for getting there.

---

## Promotion hardening, live breaker, venue calibration, re-runnable schema

314/314 tests, 0 lint errors, `tsc --noEmit` 0. Every endpoint verified 200.

### 1. Correlation-adjusted promotion

`evaluatePromotion` now counts genuinely independent trials. Four challengers
trained on the same settled calls are one experiment sampled four times; picking
the best and treating it as the survivor is the multiple-comparisons error this
system exists to avoid.

Verified: four identical return streams collapse to **1 trial of 4**. Genuinely
different models keep their count. Per-trade Sharpe added to `scoreChallenger`
(unannualised — annualising a trade sequence implies a frequency that varies with
how often the app happens to fire).

### 2. Walk-forward / recency promotion

A model is promoted on its whole record. One that earned its edge over 400 trades
and has lost for the last 60 still looks fine on average, and would keep its
position size while it bleeding. Stale edge is worse than none because it carries
risk with it.

Verified: a record of 200 good trades then 60 bad is **refused**, lifetime
expectancy still positive. A young model is *not* refused — below twice the
window it is indistinguishable from "still ramping up", and refusing would block
every new model for what is really just youth.

### 3. Circuit breaker now has fuel

`circuit.js` implemented a full breaker — drawdown, consecutive losses, staleness,
manual halt — and every gate checked it on every order. **Nothing ever called
`recordTrade` or `updateEquity`.** It was a gauge with no fuel: permanently
closed, structurally incapable of stopping anything.

Every other control runs *before* an order and assumes the model is good. This is
the only one that acts *after* reality contradicts that. Now fed from
`settleMatured`. Verified it trips on a losing streak and on drawdown even when
most trades win, and ignores malformed outcomes rather than counting them as
losses.

### 4. Calibration on the traded venue

`src/ml/venue.js`, run against the 15m history now being collected:

`
pairs            8
aligned 15m bars 2000 (20.8 days)
per-bar sd       0.6998%  |  daily-equiv vol 6.86%
cost 34bps       0.49 sd of one bar |  bars to clear costs: 1
continuation     {"20bar->1day":0.4965,"96bar->1day":0.4931,"96bar->4day":0.4597}
`

Two things worth knowing:

**Costs are not the binding constraint here.** 34bps is half of one bar's
volatility, so costs clear in a single bar. That is genuinely good news, and it is
the first measurement made on the venue actually traded.

**Continuation is 0.46-0.50 on 15m long-tail** — a coin flip, and *worse* at the
4-day horizon than the 1-day one. The daily-bar study found 0.564 continuation at
30 days on large caps. **That result does not transfer to this venue.** Every
directional assumption built on the large-cap study is now in question. Three weeks
of data, so provisional, but it is the honest first read and it is not encouraging.

### 5. Schema is re-runnable

Verified programmatically: **34 statements, every DDL guarded**, zero unguarded.
`create ... if not exists` and `alter ... add column if not exists`
throughout. It creates what is missing, leaves everything else alone, and never
drops or rewrites.

Also added the columns the app writes that were missing: `paper_calls.horizon_days`
(written by the app, absent from the schema — a guaranteed post-deploy failure),
`orders.venue_order_id` and `orders.testnet`.

### Ready for Supabase

1. Create the project
2. Paste `supabase/schema.sql` into the SQL editor — as many times as you like
3. Set `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` in `.env`
4. Restart, confirm `GET /api/health` reports `storage: supabase`

Ping me when you hit anything.

---

## Mainnet, and ten silently deleted routes (2026-10)

314/314 tests, 0 lint errors. All 43 routes verified live.

### Why it looked like testnet

`config.network` was already `mainnet` — I checked, and `NETWORK=mainnet` in
`.env` resolves correctly. The word came from four other places:

1. **`exchange.js` defaulted to sandbox.** `sandbox: opts.testnet !== false`
   meant *absent* testnet implied sandbox, so any caller that did not explicitly
   pass `testnet: false` traded against testnet while the app believed it was on
   mainnet. Now reads config.
2. **`verifyConnection` hardcoded `testnet: true`.** A user's mainnet API key
   was verified against a sandbox — which fails, because production keys do not
   authenticate on testnet URLs. Connecting an exchange could never have worked.
3. **`fetchTicker` hardcoded `testnet: true`.** Testnet covers a fraction of
   pairs and quotes different prices, so a symbol sanity check would disagree with
   the venue a real order hits and veto valid trades.
4. **The docs said it.** `deploy.md` listed `NETWORK | testnet to start`.
   Fixed.

Also fixed an inverted ternary in `executor.js`:
`opts.testnet !== undefined ? opts.testnet !== true : ...` returned **mainnet when
asked for testnet and vice versa**. The omitted case — the one actually used — was
correct, which is why it stayed hidden.

`/api/health` now reports `network` and `live_enabled`, so this question is
answerable without reading config.

### The serious finding: ten routes were deleted

Lint reported eleven unused imports in `routes/index.js`. That was not cosmetic —
unused imports named exactly the handler of a route that no longer existed:

`/keepalive`, `/model`, `POST /auth/session`, `/markets/trending`,
`/markets/movers`, `/markets/search`, `/markets/quote`, `/markets/quote/cmc`,
`/markets/chains`, `/fx`, `/fx/convert`

I deleted them during a bad line-based edit earlier in this session, then checked
route *count* and concluded nothing was lost. Counting routes does not tell you
*which* routes. The frontend's Markets page calls `trending`, `movers` and
`search` — three of the ten — so the main market screen was broken.

There is no git history to recover from: the repo has never been committed, every
file is untracked. All ten were **reconstructed** from the import list and the
frontend's API contract, not recovered. They are faithful to the contract; they
are not the original bytes.

### Why no test caught it

The route manifest listed ten routes I picked by hand. The ten that survived were
exactly the ones I had listed. A partial manifest tests your memory of what
matters, not the API.

Replaced with the full 43-route contract, and verified it genuinely fails on a
deletion rather than passing vacuously.

### Current state

`
network      : mainnet
mode         : paper
live_enabled : True
storage      : supabase  (connected)
model        : trained=True  promoted=False
`

The design is intact and enforced: the app runs paper, mainnet connector is armed,
and `promoted=False` keeps real orders off until a superior model has been built,
promoted, and watched through its quota.

### Process note

Every failure in this session came from one habit: line-index edits I could not
verify. `node --check` does not catch an undefined identifier or a deleted route,
and I treated it as proof twice. Importing the module and asserting the route
manifest are the checks that catch this class.
