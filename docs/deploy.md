# Deploy checklist for beast-trader
#
# Two services (Render backend, Vercel frontend) and one database (Supabase).
# The order matters: the database must exist and be migrated before the backend
# starts, because a fresh Render instance with no tables fails every write.

## 1. Database — Supabase

Create a project, then run `supabase/schema.sql` in the SQL editor. It is
idempotent (`create table if not exists` throughout), so running it twice is safe.

It creates seven tables:

| table | holds |
|---|---|
| `watchlist` | what the user is tracking |
| `orders` | executed and simulated orders, the training set for orders |
| `research_logs` | past research notes |
| `device_settings` | credentials, mode, risk level, per device |
| `paper_calls` | every prediction with its features and realised outcome |
| `proposals` | assisted-mode trades awaiting a wallet signature |
| `model_registry` | champion and challenger models, so learning survives restarts |

Take the service-role key from Project Settings -> API. **This key bypasses row
level security — it belongs on the server only, never in the frontend and never in
a git-tracked file.**

## 2. Backend — Render

Create a Web Service from the repo, root directory `backend`.

Build: `npm ci`
Start: `npm start`

Environment variables:

| variable | value | why |
|---|---|---|
| `JWT_SECRET` | long random string | signs device tokens |
| `SUPABASE_URL` | project URL | without it, the store is a local file |
| `SUPABASE_SERVICE_ROLE_KEY` | service key | same |
| `LIVE_TRADING_ENABLED` | `false` to start | keeps the kill switch closed |
| `NETWORK` | `mainnet` | mainnet is the default; `testnet` points at a venue sandbox |
| `POLL_INTERVAL_MS` | `30000` | 30s is safely inside free-tier rate limits |
| `COLLECT_INTRADAY` | `true` | collects history for the traded venue |

**`SUPABASE_URL` is not optional for real use.** Without it the store is
`backend/data/store.json`, and Render's filesystem is ephemeral — the paper track
record resets on every redeploy. The strategic horizon is 14 days, so a record that
resets hourly cannot answer the question the app exists to answer.

## 3. Frontend — Vercel

Import the repo, root directory `frontend`. Framework preset: Vite.

Set `VITE_API_URL` to the Render backend URL. Nothing else; the API base URL is
the only frontend configuration.

## 4. First run

1. Add a few symbols to the watchlist. The poller only records calls for symbols
   it is tracking, and without settled calls the retrainer has nothing to train on.
2. Leave the mode on Practice. Confirm `/api/paper` fills up and
   `/api/improvement` reports progress toward `MIN_ROWS`.
3. Wait for real settled calls at the **14-day** horizon. Tuning anything before
   then is fitting noise.
4. Only after that, look at whether the model beats the equal-weight benchmark.

## 5. Before enabling real money

- [ ] Supabase configured and verified (restart the backend and confirm the
      record survives)
- [ ] A model has passed the promotion gate on settled live calls — not on backtest
- [ ] `liveReadiness` returns every check green
- [ ] You have read the app's own research: the current strategy returns the same
      as holding every asset, and the trained model sits at 48-55%
- [ ] The risk slider is somewhere you have actually thought about
- [ ] Only trading capital is in the connected account
