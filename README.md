# Beast‑Trader

A lightweight, device‑centric crypto trader using Needle for research, WalletConnect for authentication, and Supabase for data persistence.

## Kronos sidecar (optional)

Predictions can optionally come from the Kronos foundation model served on Modal, deployed from `E:\Projects\modal-kronos` (see its README). Enable by setting in `.env` and the Render env vars:

```
KRONOS_SERVICE_URL=https://<workspace>--modal-kronos--web-<hash>.modal.run
KRONOS_API_KEY=<secret>
```

Unset, the app uses its local model tiers only. When enabled, the Kronos forecast runs first; on error or timeout (15 s) the local logistic model and rules tiers take over. Every Kronos call is logged to the `kronos_calls` Supabase table for later fine-tuning and ranking. Run `supabase/schema.sql` once in the Supabase SQL editor to create the table (safe to re-run).

## Deploy

`render.yaml` provisions the backend on Render; run the same `supabase/schema.sql`, then set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `CMC_API_KEY` (optional) and the Kronos pair (optional).

## Test

```
npm test        # backend suite (374 tests)
npm run lint    # oxlint
```
