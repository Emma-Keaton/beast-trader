# Deploy Runbook

Vercel (frontend) + Render (backend) + Supabase (database). UptimeRobot keeps the
backend awake. Total cost: **$0**.

Follow in order. Each step depends on the one before it.

---

## 1. Supabase first — nothing survives without it

Render's filesystem is **ephemeral**. From Render's own docs:

> Render *spins down* a Free web service that goes **15 minutes** without
> receiving any inbound traffic… any changes to its local filesystem are *lost*
> every time the service redeploys, restarts, or spins down.

So on a free instance, anything written to disk — trained models, the champion,
every challenger, the paper-call ledger — is deleted on every idle period. This
is documented default behaviour, not a hypothetical.

### Create the project

1. <https://supabase.com/dashboard> → **New project**
2. Save the database password. It is not shown again.
3. **SQL Editor** → paste all of `supabase/schema.sql` → **Run**

That creates six tables. Two are the reason this step is not optional:

| Table | Why it exists |
|---|---|
| `paper_calls` | The training set. Every prediction with its feature vector, settled against the real price. Without it the app has nothing to learn from. |
| `model_registry` | The champion and challengers. Without it a spin-down deletes weeks of accumulated evidence. |

`orders` is the third that matters, and easy to overlook: it started as a
display log and is now a training source in its own right. See
[trade-history.md](trade-history.md) for the full picture.

`orders` is the third one that matters, and it is easy to overlook. It started as
a display log, then became a training source in its own right: it now carries
`features`, `probability`, `exit_price`, `pnl_pct` and `settled_at`, so an
executed trade — a real fill, real fees, real size — is a labelled example
rather than just something to look at.

### Re-running the schema later

`create table if not exists` is a no-op on a table that already exists, so if
you ever created the database from an **earlier** version of this file it will be
missing columns added since. The bottom of `schema.sql` has additive,
idempotent `alter table ... add column if not exists` statements for exactly
that. **Just re-run the whole file** — it is safe to run on a fresh database and
on an existing one.

If the app logs `column "features" does not exist` for the `orders` table, you
are in that situation: re-run the schema.

### Collect two values

**Project Settings → API**:

- **Project URL** → `SUPABASE_URL`
- **service_role** key → `SUPABASE_SERVICE_ROLE_KEY`

> `service_role` bypasses RLS. It is a server-side secret: Render env vars only.
> Never the frontend, never git, never a screenshot.

---

## 2. GitHub

The repo is currently untracked — nothing has ever been pushed.

```powershell
cd E:\Projects\beast-trader
git add .
git status          # read this before committing
git commit -m "Beast-Trader: crypto paper-trading app with self-improving models"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

**Check `git status` first.** `.gitignore` excludes `.env`, `node_modules/`,
`backend/data/history/` and `backend/data/store.json`, so secrets and bulk
cached history stay out.

`backend/data/models/*.json` is deliberately **un-ignored** — the model file must
reach the server, or predictions silently fall back to the weaker rules tier
with no error to explain why.

---

## 3. Render (backend)

`render.yaml` is a Blueprint, so this is one click:

1. <https://dashboard.render.com> → **New** → **Blueprint**
2. Point it at the repo. Render reads `render.yaml` and creates the service.

Set the two secrets it cannot generate:

| Variable | Where |
|---|---|
| `SUPABASE_URL` | Supabase → Project Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API → service_role |

Optional:

| Variable | If omitted |
|---|---|
| `CMC_API_KEY` | Falls back to CoinMarketCap's keyless API. The free Hobby tier is fine — the app holds 20% of the budget back and reports usage at `/api/health`. |

`JWT_SECRET` auto-generates. Leave it. **The secret-encryption key in Settings is
derived from it**, so changing it later makes every stored API key undecryptable.

Confirm in the first deploy log:

```
[registry] champion=none challengers=0
```

That line proves the durable registry loaded.

---

## 4. Vercel (frontend)

1. <https://vercel.com/new> → import the repo
2. **Root Directory** → `frontend`
3. Framework preset → **Vite**
4. Env var: `VITE_API_URL` = `https://<your-render-host>.onrender.com`

**Deploy the backend first.** Without `VITE_API_URL` the frontend calls its own
origin and every request 404s — which looks like a broken app, not a missing
variable.

---

## 5. UptimeRobot — keeping it awake

The poller runs `setInterval` in-process, so it only runs while the process
lives. Render sleeps a free instance after 15 idle minutes, and **no code inside
your container can prevent that** — only inbound traffic can.

1. <https://uptimerobot.com> → **Add New Monitor**
2. Type **HTTP(s)**
3. URL `https://<your-render-host>/api/keepalive`
4. **Monitoring Interval: 5 minutes** (inside the 15-minute window)
5. **Timeout: 90 seconds or more.** Render's cold start takes ~60s; a shorter
   timeout makes the monitor flap DOWN on every wake.
6. Create

~8,600 requests/month, free (50 monitors, 5-minute minimum).

`/api/keepalive` is a dedicated cheap endpoint for exactly this. It returns
liveness plus registry status and deliberately does **not** trigger a retrain —
`IMPROVE_INTERVAL_MS` governs that, and letting a monitor drive model updates
would couple liveness to learning:

```json
{ "ok": true, "at": "…", "storage": "supabase",
  "registry": { "champion": false, "challengers": 0 } }
```

> A monitor reporting DOWN here usually means the service is **asleep**, not
> broken. Give it 90s of timeout margin before treating a DOWN as real.

### What this does and does not solve

**Does:** keeps the container alive so the 30s poller and the 6-hourly
improvement cycle actually run. This is what makes unattended paper trading
possible on a free tier.

**Does not:** make local files durable. The container still restarts on deploys,
and Render may restart it at any time. **That is why the model registry and
paper calls live in Supabase** — the heartbeat handles uptime, Supabase handles
durability. Neither alone is sufficient.

### Verify

```bash
curl -s https://<your-render-host>/api/improvement/progress
```

If `settledCalls` does not move over a few hours, the poller has stopped — check
the Render logs for the `[poller]` line.

---

## 6. Watching the week

Paper mode runs for at least a week before live is discussed. Three endpoints
say whether that week is producing anything:

| Endpoint | Answers |
|---|---|
| `/api/health` | Is it up? CoinMarketCap usage, uptime, current mode. |
| `/api/improvement` | Champion, challengers ranked, what the last cycle did. |
| `/api/improvement/progress` | **Is the learning loop alive?** |

`/api/improvement/progress`:

```json
{
  "mode": "paper",
  "daysObserved": 0.16,
  "targetDays": 7,
  "settledCalls": 185,
  "openCalls": 92,
  "trainableCalls": 0,
  "callsUntilRetrain": 40,
  "onTrack": false
}
```

`trainableCalls` is the honest one: settled calls **carrying a feature vector**.
Only those can train a model. High `settledCalls` with low `trainableCalls`
means calls happen but nothing is learned from them.

`fromOrders` is the count that came from **executed** trades rather than paper
rehearsals. It stays 0 until the autopilot places a trade — the first few days
are expected to show 0 here, because a model must be promoted before it can
trade at all.

`onTrack` requires **both** seven days elapsed and enough trainable calls.
Elapsed time alone is not progress, and a burst of correlated calls is not
evidence.

> On a fresh deploy `trainableCalls` starts at **0** even if older calls exist.
> Those predate feature capture and cannot train a model — a row with an imputed
> input teaches nothing real, so they are skipped rather than faked.

---

## 7. What must be true before live trading

Live trading is blocked in three independent places. All three must open.

1. **`TRADING_MODE=live`** — and even then `executor.js` *parks* the order with
   `status: "queued_live"`. No exchange connector or wallet signer exists, so no
   code path can move funds. Deliberate.
2. **The model must be promoted.** `canAutoTrade()` is false unless
   `model.promoted` is true, and the current model is **not** promoted. Its own
   verdict: *"Not accurate enough (51% right — needs 53%)"* and *"Its edge could
   be luck rather than skill."*

   Promotion requires **all** of: ≥30 settled calls, positive net expectancy,
   ≥0.95 deflated Sharpe, and beating the champion's own live record — plus
   `minTrackDays` (3) of accrued evidence. That last rule matters more than it
   looks: 200 calls accumulated in twenty minutes are highly correlated and
   prove far less than 200 calls spread across a fortnight of different market
   regimes. The age floor stops a burst of same-regime activity from passing
   as a well-tested record.
3. **A challenger must clear every gate** in `PROMOTION_RULES`: ≥30 settled
   calls **and** positive net expectancy **and** ≥3 days of track record **and**
   it must beat the champion's live expectancy.

The 3-day rule exists because trade count alone is not evidence: 200 calls
earned in one burst are highly correlated and prove little, while 200 spread
across different market regimes prove much more. A test pins this.

### Before building any live connector

In order:

1. Paper trading with **positive expectancy after fees**, sustained over weeks.
2. **Deflated Sharpe above 0.95** — the edge survives accounting for the many
   configurations tried to find it.
3. Verification the edge is **not** an artifact of the `noiseMult` filter, which
   drops rows below half the typical bar move and so only scores the model on
   days that already moved. Currently unresolved.
4. Exchange keys with **withdrawals disabled**, IP-restricted to Render's egress.
5. `MAX_ORDER_USD` trivial for the first live run.

Building the connector before that evidence exists would build a machine for
losing money faster.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| Frontend loads, every request 404s | `VITE_API_URL` unset — the app is calling its own origin. |
| First render slow, then normal | Render cold start (~1 min) after spin-down. UptimeRobot reduces how often this happens. |
| `/api/improvement/progress` errors | Supabase unreachable. Check both env vars and that the service_role key was copied in full. |
| `trainableCalls` stays 0 | Calls recorded without feature vectors. Check `predict.js` emits `features`. |
| `champion=none` in logs | Expected until promotion, or the registry failed — look for `[registry] warm failed`. |
| Models reset unexpectedly | Local disk. Confirm `SUPABASE_URL` and the service key are set; without them the registry falls back to ephemeral files. |

## Cost

| Service | Plan | Cost |
|---|---|---|
| Vercel | Hobby | $0 |
| Supabase | Free | $0 |
| Render | Free | $0 |
| UptimeRobot | Free | $0 |
| **Total** | | **$0** |

**The tradeoff, stated plainly:** the poller only runs while UptimeRobot's
heartbeat reaches it, and Render may restart the container at any time.
Durability is Supabase's job, so a restart costs a few seconds of missed ticks
and nothing else.

If the week goes well, Render's `0.5c-512mb` plan ($7/month) removes the
heartbeat and spin-downs entirely — at which point UptimeRobot becomes monitoring
rather than load-bearing.
