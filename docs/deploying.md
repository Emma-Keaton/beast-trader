# Deploying Beast-Trader

Vercel (frontend) + Render (backend) + Supabase (database). UptimeRobot keeps the
backend awake. Total cost: **$0**.

> **Start here for the actual deploy steps → [deploy-runbook.md](deploy-runbook.md).**
> This file records *why* the architecture is shaped this way. The background is
> preserved below.

---

## 1. Can the whole app run on free Vercel alone?

**No — and the reason is structural, not a matter of configuration.**

Confirmed first: there is **no Python anywhere** in this project. The entire
stack is Node.js (Express backend) plus a React/Vite frontend. So "does it need
Python" is answered — it does not. The blocker is something else.

Vercel's free tier runs **serverless functions, not servers**. Three things in
this app need a process that stays alive between requests:

| Requirement | Where it lives | Why Vercel free can't do it |
| --- | --- | --- |
| A 30-second background poller | `backend/src/services/poller.js` — `setInterval` | Serverless instances are frozen between invocations and reclaimed after the response. An interval never fires. |
| The on-disk data store | `backend/data/store.json` via `store.js` | The filesystem is ephemeral and read-only outside `/tmp`. Every cold start and every redeploy would wipe the watchlist. |
| Long-lived connections | implied by auto-polling | Functions are request/response only. |

Vercel **Cron** does not rescue this. On the Hobby plan it runs **once a day**,
with a hard cap of two cron jobs. The app polls every 30 seconds.

### What actually works, on two free tiers

| Piece | Host | Free tier | Cost |
| --- | --- | --- | --- |
| Frontend (React/Vite) | **Vercel** | Hobby — static build, generous bandwidth | $0 |
| Backend (Express) | **Render** | Free web service — sleeps after 15 min idle, wakes on request | $0 |
| Database (optional) | **Supabase** | Free tier — 500MB, needed so data survives restarts | $0 |

`render.yaml` is already in the repo, so Render deploys via the blue "New
Blueprint" button with no configuration. This is the split the project was
already built for.

### Making the free tiers behave

1. **Turn on Supabase.** Without it, Render's ephemeral disk means a user's
   watchlist can vanish on the next free-tier recycle. Run `supabase/schema.sql`,
   set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` on both hosts, and data
   becomes durable. This is the single most important step for "deploy ready".
2. **Expect cold starts.** The Render free tier sleeps after 15 minutes idle, so
   the first request after a quiet period takes ~30–50s. The frontend must show
   a loading state on first paint (it does) rather than appearing broken.
3. **The poller is the real cost.** A sleeping free service still runs its
   interval while awake. If polling every 30s across many users becomes
   expensive, the honest options are a longer `POLL_INTERVAL_MS` or a
   scheduled ping (e.g. UptimeRobot) to keep the instance awake. Do not scale
   by raising provider rate limits.

## 2. "Needle AI"

I did not wire this in, because it cannot be wired in.

**Needle (needle.com) is an AI code generator** — a desktop tool in the same
category as Cursor or GitHub Copilot. It is not a runtime service, has no API an
application can call, and has no place in a deployed app's dependency graph. It
generates code *once*; it does not "automate" anything at runtime.

If the goal is a live AI layer in the product, the realistic options are:

- **The model that is already here** — the trained logistic model that produces
  every prediction, gated by the promotion rules in `ml/evaluate.js`. This is
  real, runs in-process, costs nothing, and is honest about its accuracy.
- **An external LLM API** (Anthropic, OpenAI, Gemini) used at *training* or
  *research* time to write explanations or generate feature ideas. This would
  need a key, a budget, and a privacy review, because it would send market data
  to a third party.

I did not add either, because both are product decisions rather than
engineering, and the second one costs money. Say the word and I will add the
first properly.

## 3. Automated trade execution "without API keys or secrets"

**This cannot be built, and the reason is the security model itself, not a
limitation of the tooling.**

To move real funds, something must produce a valid signature:

- **A CEX** (Binance, Coinbase) requires a signed REST request. The signature
  is made with an API secret. Without it, no order. This is not configurable
  around.
- **A blockchain** requires a valid signature from the holder of the private
  key. A wallet app integration (WalletConnect, FastLink-style) *does* let the
  app request a transaction — but a human must then approve it in the wallet.
  That approval is the security control, not an obstacle to route around.
- **The only way to remove the human** is for the app to hold the private key
  or the API secret itself and sign autonomously. That is a hot wallet, and it
  is the design behind essentially every exchange and wallet hack in history: a
  server-side key, reachable over the network, signing on a timer.

So the honest options are:

1. **Paper mode** (the current default) — the full pipeline runs with zero
   capital at risk. This is what the app does today.
2. **User-approved transactions** — the app prepares the trade, the user's
   wallet signs it. Real money, but a human authorises every one. This is how
   legitimate DeFi front-ends work, and it is safe because the key never leaves
   the wallet.
3. **Server-side CEX keys, done defensively** — only if you accept the risk.
   See the checklist below; the controls are not optional.

I have deliberately not built (3) or a key-holding signer. If you want (2), I
can build it properly: prepare-transaction → wallet signature → submit, with
clear approval UI and a hard spend cap. That is a real, safe feature.

## 4. Getting exchange API keys and wallet credentials

For **market data** keys (no money, no risk) — these are safe to add:

| Provider | Where to get a key | Free tier |
| --- | --- | --- |
| CoinMarketCap | https://coinmarketcap.com/en/professional/ → Account → API Keys | 10,000 calls/month |
| CoinGecko | https://www.coingecko.com/en/api | ~30 calls/min |
| Binance | https://www.binance.com/en/my/settings/api-management | Keyless public endpoints work |
| DexScreener | https://docs.dexscreener.com/api-reference | Keyless |
| DefiLlama | https://defillama.com/docs/api | Keyless |
| Exchange rates | https://open.er-api.com | Keyless (in use) |

Add yours as `CMC_API_KEY` in Render's environment variables. The backend picks
it up on the next deploy and switches to the keyed API automatically; if the key
is missing or rejected, it logs a warning and keeps using the keyless feed.

For **trading** keys — these can move money, so read this first.

| Exchange | Where to create a key | Official docs |
| --- | --- | --- |
| Binance | Account → API Management | https://developers.binance.com/docs/binance-spot-api-docs/rest-api |
| Coinbase Advanced | Console → API Keys | https://docs.cdp.coinbase.com/advanced-trade/docs |
| Kraken | Settings → API keys | https://docs.kraken.com/rest/ |
| Bybit | Account → API | https://bybit-exchange.github.io/docs/v5/intro |
| OKX | Developer → API | https://www.okx.com/docs-v5/en/ |

**The mandatory safety controls, every time, no exceptions:**

1. **Disable withdrawals.** Leave the "Enable Withdrawals" toggle **off**. A
   trade-only key cannot be used to steal funds, which is the single control
   that matters most. Most exchanges make this the default — never enable it.
2. **IP-restrict the key** to your server's IP.
3. **Never commit keys to git.** Beast-Trader encrypts per-device secrets with
   AES-256-GCM before storing them, but the encryption key derives from
   `JWT_SECRET` — so **`JWT_SECRET` must be set to a long random value in
   production** (Render's `generateValue: true` does this), or the encryption
   is only as good as a random default regenerated on every restart.
4. **Start with the smallest possible testnet or low notional.** Use
   `MAX_ORDER_USD=1` and a sandbox account before any real size.
5. **Revoke immediately** if the key is ever pasted into a chat, a log, a
   screenshot, or a commit.

**For self-custody wallet signing**, the key never leaves the user's wallet and
should never be requested by this or any other application. If a prompt asks
for a seed phrase or a raw private key, it is a scam — close it. Legitimate
## 5. What is still missing for "100% deploy ready"

Ordered by how much it matters, not by effort.

**Blocking — do these first**

1. **Turn on Supabase.** Everything is currently stored in a local JSON file
   that Render wipes on recycle. One user's watchlist should not depend on
   whether their container has been idle for 15 minutes. `supabase/schema.sql`
   is ready; add the two env vars.
2. **Set a real `JWT_SECRET`.** `render.yaml` uses `generateValue: true`, which
   is correct, but confirm it is set. The secret-encryption key derives from
   it, and the fallback is a random value regenerated on every restart — which
   silently invalidates every stored key.
3. **Set `VITE_API_URL` on Vercel** to the Render URL, then deploy. Without it
   the frontend calls its own origin and every request 404s.
4. **Smoke-test the deployed pair.** `node scripts/smoke.js` against the real
   backend URL with `--keep`, and confirm the Markets page loads tokens.

**Important, not blocking**

5. **CI.** There is no `.github/workflows` directory. `npx oxlint`, `node --test`
   and `npm run build` all run clean locally and should run on every push.
6. **Cold-start UX.** Render's free tier sleeps. Confirm the frontend shows a
   loading state on a 50-second first request rather than a blank page, and
   consider a 60s client timeout with a retry.
7. **Error monitoring.** Failures are logged to stdout, which Render captures
   but nobody reads. A free Sentry or a uptime ping would close the loop.
8. **A LICENSE.** Absent. Matters if anyone else is to contribute.
9. **Rate-limit headroom.** The poller fans out per watchlist item. With a
   large watchlist on a free tier this will self-throttle. `MAX_WATCHLIST`
   would be a sensible cap.

**Deliberately not "missing"**

10. **A profitable model.** The trained model is at 49.9% accuracy and a 0%
    deflated Sharpe. It is unpromoted on purpose, and auto-trading is blocked
    because of it. Shipping a *promoted* model would mean the promotion gate is
    lying. The paper ledger exists to accumulate the evidence that would
    eventually justify changing that.
11. **Live order execution connectors.** Binance/Jupiter/WalletConnect signing
    is unbuilt. See §3 — the safe version (user-approved) is a real feature
    worth building; the unsafe version is not.


