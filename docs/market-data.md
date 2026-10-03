# Beast-Trader — market data architecture

Everything here is **keyless and free-tier friendly**. No API keys are
required to run the app, and no provider is trusted enough to move money on
its own. Adding a paid key makes the data better; it does not make the
strategy correct.

## The four sources, and what each is for

| Source | Used for | Why it is here |
| --- | --- | --- |
| **DexScreener** | DEX prices, liquidity, 24h volume, buy/sell flow, multi-chain discovery | The only keyless source that covers Solana, Base, Sui, BSC and Arbitrum per-token. Everything on-chain funnels through here. |
| **CoinMarketCap** | Reference price, market cap, and large-cap movers | The only source covering *every* listed asset. It is wide but shallow, so it is used for breadth and cross-checks, never for on-chain liquidity. Keyless by default; a free Hobby key raises the rate limit. See §"CoinMarketCap quota" below. |
| **Binance** | Spot prices for coins it lists | No rate limit, no key, and it is the price most people mean when they say "the price". Keeps training data consistent with what users see. |
| **DefiLlama** | Contract-price cross-check, chain volume | Independent second opinion. A >5% disagreement between DefiLlama and the DEX is flagged rather than silently averaged. |

DexScreener has **no "top gainers across every chain" endpoint**, so
multi-chain discovery is a sweep: one search per representative quote pair
per chain (`SOL/USDC`, `WETH/USDC`, `WBNB/USDT`, `SUI/USDC`, …), filtered to
that chain so a "SOL" pool on Base cannot masquerade as Solana.

## The primitives that keep it running on a free tier

`core/http.js` — shared client with timeouts, jittered exponential backoff,
per-host self-throttling, and a circuit breaker per host. A provider that
starts failing is backed off and then skipped entirely, so one dead upstream
cannot slow down or break a page.

`core/cache.js` — TTL + LRU with single-flight and stale-while-revalidate.
A burst of concurrent requests for the same key produces **one** upstream
call; a cached value past its TTL is still served while the refresh runs
behind the scenes. Market data is 20s–5min stale by nature, so this is a
feature, not a compromise.

`core/batcher.js` — debounced fan-out for the poller, so a burst of watch
requests collapses into a small number of upstream calls.

Every route degrades rather than fails. A dead DexScreener shows an empty
movers list; it does not produce a 500.

## CoinMarketCap quota

The free **Hobby** plan allows 10,000 credits a month. Four things about this
API are easy to get wrong, and the app handles each explicitly
(`services/cmc.js`, `core/budget.js`):

1. **Credit cost scales with `limit`.** Measured against the live API:
   `limit=100` costs **1** credit, 500 costs 2, 1000 costs 4, 5000 costs 20 —
   that is, `ceil(limit / 250)`. A naive "top 500 every 3 minutes" loop burns
   ~28,800 credits a month and would exhaust the free plan in ten days.

   The app therefore fetches **`limit=100`**, refreshed every **30 minutes**:
   48 credits/day, ~1,440/month — about **14%** of the allowance. The top 100 by
   market cap contains every coin that survives the $5M-cap filter anyway, so
   the wider pages returned rows that were thrown away.

2. **The V1 endpoints are deprecated.** `/v1/cryptocurrency/listings/latest` and
   `/v1/cryptocurrency/quotes/latest` both appear in CMC's Deprecated list; the
   live paths are **V3**. The app calls only V3.

3. **There is an official keyless API.** `pro-api.coinmarketcap.com/public-api`
   needs no key, on an IP-based rate pool that does **not** consume the user's
   credits. The app uses it as the fallback, so a free key can never be
   exhausted — the worst case is that the app quietly runs keyless for a few
   days.

4. **Errors arrive as HTTP 200.** A rejected call returns
   `status.error_code: 1005` with a 200 status, so `res.ok` alone treats an
   error page as data. Every response is validated against its own `status`
   block, and `error_code` is compared numerically because CMC returns it as
   the string `"0"` on some routes and the number `0` on others.

### Behaviour under each condition

| Condition | What happens | Visible at |
| --- | --- | --- |
| No key configured | Keyless public API | `/api/health` → `mode: "keyless"` |
| Valid key, budget remaining | Keyed API, credits charged | `mode: "keyed"` |
| Key wrong or revoked | Logged **once**, key disabled for the month, keyless takes over | `mode: "keyless-key-rejected"` |
| Monthly budget spent | Keyless public API, keyed paused | `mode: "keyless-budget-spent"` |
| CoinMarketCap down | Stale last-good page served, or DEX-only movers | — (no user-visible error) |

The budget holds back 20% as headroom, so a traffic spike or a bug cannot reach
the plan's hard cap. `GET /api/health` reports `used`, `ceiling`, `remaining`
and `mode` every time, so usage is watched rather than discovered when the key
suddenly stops working.

### Upgrading the plan

When the free tier is no longer enough, raise the budget to match the new plan —
nothing else changes:

```
CMC_MONTHLY_CREDIT_BUDGET=50000    # Basic
CMC_MONTHLY_CREDIT_BUDGET=200000   # Professional
```

Per-plan allowances: Hobby 10,000 · Basic 50,000 · Professional 200,000 ·
Business 1,000,000. Keep the default 20% headroom; it is what stops a bad
deploy from costing money.

## Honesty rules baked into the data layer


- **Thin liquidity is filtered before ranking.** A coin that "up 400%" on $400
  of liquidity is not a mover, it is a rounding error. Movers are ranked only
  after a liquidity/volume floor.
- **CMC's own gainers list is unusable.** Its top rows are unvetted micro-caps
  with a market cap of literally $0 and eight-figure percentages. Beast
  fetches the top 500 by market cap and ranks them locally instead.
- **Junk tickers are rejected, not truncated.** Promoted feeds occasionally
  carry 2,000-character "symbols"; truncating one would invent a ticker for a
  coin that does not exist, so they are dropped.
- **Identity is chain + contract.** The same ticker exists on many chains, so
  a token is identified by `chain:address` with a `chain:symbol` alias index
  to stop one coin filling the whole list.

## The model is not trusted, by design

`ml/stats.js` (PSR, DSR, effective trials) and `ml/purged.js` (purging,
embargo, CPCV) exist so the promotion gate can ask "is this edge real?" rather
than "is it positive?". The current model scores 49.9% accuracy, −0.165% per
trade after fees, and a **0% deflated Sharpe** — the luckiest of everything we
tried. It is therefore unpromoted, and auto-trading stays blocked. Manual
paper trading works, and the app says why in plain English.

## Free-tier notes

- No new runtime dependencies were added; the primitives are dependency-free.
- `scripts/build-assets.ps1` regenerates every favicon, app icon, social card
  and splash from the two logo masters, with background colours sampled from
  the artwork rather than guessed.
- `npm run smoke` in `backend/` boots a throwaway server and exercises the
  full pipeline against live data — session, movers, research, star, poll,
  paper trade, governance and cleanup — in one command.
