-- beast-trader schema. SAFE TO RUN REPEATEDLY.
--
-- Every statement here is guarded (`create ... if not exists`, `alter ... add
-- column if not exists`), so this file can be pasted into the Supabase SQL editor
-- as many times as you like. It creates what is missing and leaves everything
-- else alone. It never drops, truncates or rewrites a table, so running it
-- against a database that already holds paper calls, orders, models or user
-- credentials will not damage them.
--
-- Order of operations, if this is your first run:
--   1. Create the Supabase project.
--   2. Paste this whole file into SQL Editor and run it. Repeat it whenever you
--      want — after a deploy, or to pick up new columns.
--   3. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY on the backend.
--   4. Restart the backend and confirm GET /api/health reports storage=supabase.
--
-- Tables created:
--   watchlist       what the user is tracking
--   orders          executed and simulated orders; also a training source
--   research_logs   past research notes
--   device_settings credentials, mode, risk level - one row per device
--   paper_calls     every prediction with its features and realised outcome
--   proposals       assisted-mode trades awaiting a wallet signature
--   model_registry  champion and challengers, so learning survives restarts
--   dex_snapshots   point-in-time DEX observations for feature lookup
--   whale_flows     per-wallet DEX flow events
--   whale_profiles  per-wallet rollups
--   kronos_calls    Kronos sidecar forecasts joined to realized returns later
--
-- SECURITY, LAYER 2: the service-role key.
--
-- It is the only client, and it carries BYPASSRLS, so it is unaffected by the
-- RLS statements at the bottom of this file. That is also why leaking it is
-- catastrophic: it bypasses everything below. It must live only in the server
-- environment. Never in the frontend, never in a committed file, never in a
-- screenshot. Rotate it in Project Settings -> API if that ever happens.
--
-- Rows are scoped by `device_id`, which the backend binds to a signed device
-- JWT. That is the authorisation model; see docs/deploy.md.
create table if not exists watchlist (
  id uuid primary key default gen_random_uuid(),
  device_id text not null,
  symbol text not null,
  name text,
  token_id text,          -- coingecko id for CEX-listed tokens
  chain text default 'coingecko',
  source text default 'coingecko',
  created_at timestamptz default now(),
  unique (device_id, symbol)
);

create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  device_id text not null,
  symbol text not null,
  chain text,
  venue text,             -- cex | dex
  side text,              -- BUY | SELL
  qty numeric,
  notional_usd numeric,
  limit_price numeric,
  stop_loss numeric,
  take_profit numeric,
  confidence numeric,
  rationale text,
  mode text,              -- paper | live
  status text,            -- filled_paper | queued_live | filled_live | settled
  filled_price numeric,
  filled_at timestamptz,
  pnl_usd numeric,
  note text,
  -- Training columns. An executed order is the highest-quality training record
  -- the app can produce: it carries a real fill, real fees and real size. Without
  -- these the orders table is a display log only, and every model learns from
  -- synthetic paper calls rather than from what was actually traded.
  probability numeric,    -- calibrated P(up) the decision was made on
  model text,             -- which model produced it (champion or a challenger)
  features jsonb,         -- feature vector at decision time
  features_version text,  -- which feature build produced this vector
  -- Outcome columns, filled when the position closes. `pnl_pct` is net of fees
  -- and is the figure the retrainer treats as the label.
  exit_price numeric,
  pnl_pct numeric,
  due_at timestamptz,     -- when this position is marked to market
  settled_at timestamptz,
  created_at timestamptz default now()
);

create table if not exists research_logs (
  id uuid primary key default gen_random_uuid(),
  device_id text not null,
  token text not null,
  data_json jsonb not null,
  signal text,
  confidence numeric,
  created_at timestamptz default now()
);

create table if not exists device_settings (
  id uuid primary key default gen_random_uuid(),
  device_id text not null unique,
  settings jsonb not null default '{}'::jsonb,  -- secrets stored AES-256-GCM encrypted by the backend
  created_at timestamptz default now()
);

-- The learning substrate. Every prediction the app makes is recorded here with
-- the exact feature vector that produced it, and settled later against the
-- price it actually reached. The retrainer learns only from settled rows, so
-- this table is the only durable record of what the app has learned *from*.
-- Without it in Supabase, a Render spin-down deletes the training set.
--
-- This is deliberately NOT device-scoped for learning purposes: the app reads
-- across every device (`listAllRows`) because one shared model trained on all
-- users' outcomes is better than N models each trained on a handful of calls.
-- device_id is still recorded, for per-user attribution and audit.
create table if not exists paper_calls (
  id uuid primary key default gen_random_uuid(),
  device_id text not null,
  symbol text not null,
  side text,              -- LONG | SHORT
  confidence numeric,
  probability numeric,    -- calibrated P(up), for calibration scoring
  model text,             -- which model produced the call
  entry_price numeric,
  exit_price numeric,
  return_pct numeric,      -- net log-ish return after the 0.1% taker fee
  buy_hold_pct numeric,    -- the "just hold" control, same fee
  beaten_market boolean,   -- did this beat holding the coin?
  won boolean,             -- net > 0
  features jsonb,         -- feature vector at prediction time (the training input)
  opened_at timestamptz,
  due_at timestamptz,     -- when the call matures
  settled_at timestamptz,
  status text,            -- open | settled
  created_at timestamptz default now()
);

-- Assisted mode: trades the auto-trader wants to make, waiting on a human
-- signature in the user's wallet.
--
-- Distinct from `orders` because a proposal has NOT executed. An order is a
-- record of something that happened; a proposal is a record of something the app
-- decided and asked permission for. Conflating them would put unsigned intentions
-- into the training set as if they were fills, which would teach the retrainer
-- from trades that never happened.
--
-- No key material is stored here, deliberately. `signature` holds the signed
-- transaction payload recorded *after* the wallet signs, for audit — it is never
-- read, never forwarded, and never used to authorise anything. The app cannot
-- act on this row; only the user's wallet can, which is the whole design.
create table if not exists proposals (
  id text primary key,              -- app-generated, e.g. 'prop_m1x2ab_q7f9'
  device_id text not null,
  symbol text not null,
  side text not null,               -- BUY | SELL
  amount numeric,
  notional_usd numeric,
  limit_price numeric,
  venue text,                       -- exchange id or 'wallet'
  status text not null default 'pending_signature',
      -- pending_signature | executed | declined | failed | expired
  rationale jsonb,                  -- { model, prob_up, confidence, expected_move,
                                     --   round_trip_cost_bps, edge_after_cost }
  signature text,                   -- audit only; never used to authorise anything
  venue_order_id text,
  note text,
  created_at timestamptz default now(),
  expires_at timestamptz not null,  -- proposals lapse; see PROPOSAL_TTL_MS
  decided_at timestamptz
);

-- Partial index: the inbox is always "what is still signable", and that is a
-- small set. Indexing only live rows keeps the query cheap as decided proposals
-- accumulate over months.
create index if not exists proposals_live_idx
  on proposals (device_id, created_at desc)
  where status = 'pending_signature';

-- Durable model registry. Render's filesystem is ephemeral: a free instance
-- loses local files on every spin-down, restart and redeploy. Storing the
-- champion and challengers here is what allows the app to learn across days
-- rather than across 15-minute idle windows.
create table if not exists model_registry (
  id text primary key,               -- 'champion' or a challenger id
  role text not null,                -- champion | challenger
  payload jsonb not null,            -- scaler, weights, bias, features, metrics
  label text,
  parent text,
  track_record jsonb,                -- challenger's settled returns
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists watchlist_device_idx on watchlist (device_id);
create index if not exists orders_device_idx on orders (device_id, created_at desc);
create index if not exists research_device_idx on research_logs (device_id, created_at desc);
create index if not exists paper_calls_device_idx on paper_calls (device_id, created_at desc);
-- The retrainer's hot path: settled rows across all devices, newest first.
create index if not exists paper_calls_settled_idx on paper_calls (status, created_at desc);
-- Orders are a second training source once they carry features and an outcome.
-- The retrainer sweeps settled orders across all devices, so the index is on
-- status alone rather than per-device.
create index if not exists orders_settled_idx on orders (status, created_at desc);

-- ── Migrations ──────────────────────────────────────────────────────────────
-- `create table if not exists` is a no-op on a table that already exists, so a
-- database created from an earlier version of this file will be missing columns
-- added later. These are additive and idempotent: safe to run on a fresh
-- database and on an existing one.

-- Columns the app writes that are not in the base `create table` above, because
-- they were added after the tables were first written. Every one is guarded, so
-- running this file twice is a no-op and running it against an older deployment
-- brings that deployment up to date without touching its rows.
--
-- `horizon_days` matters more than it looks: two horizons are in play (3d entry,
-- 14d strategic) and this records which window each call was scored over. Without
-- it the two ledgers are indistinguishable after the fact and cannot be audited.
alter table paper_calls add column if not exists horizon_days integer;

-- Orders became a training source, so they need the same columns paper calls
-- already had. Run this if the app logs a "column does not exist" error for
-- `features` or `pnl_pct` on the orders table.
alter table orders add column if not exists probability numeric;
alter table orders add column if not exists model text;
alter table orders add column if not exists features jsonb;
alter table orders add column if not exists features_version text;
alter table orders add column if not exists exit_price numeric;
alter table orders add column if not exists pnl_pct numeric;
alter table orders add column if not exists due_at timestamptz;
alter table orders add column if not exists settled_at timestamptz;

-- Filled only after the venue accepts a live order, for reconciliation against
-- the exchange's own history. Null on every paper and blocked order, which is
-- correct: those never reached a venue.
alter table orders add column if not exists venue_order_id text;
alter table orders add column if not exists testnet boolean;

-- The paper-call training substrate, added alongside the model registry.
alter table paper_calls add column if not exists features jsonb;
alter table paper_calls add column if not exists features_version text;
alter table paper_calls add column if not exists pnl_pct numeric;
alter table paper_calls add column if not exists exit_ts timestamptz;


-- ─────────────────────────────────────────────────────────────────────────────
-- SECURITY, LAYER 1: row level security.
--
-- Placed last, because RLS can only be enabled on a table that exists. Running
-- this file top-to-bottom creates the tables first and then secures them.
--
-- The backend connects with the SERVICE ROLE key, which carries BYPASSRLS and is
-- therefore unaffected by anything below. The app keeps working exactly as it did.
--
-- What this actually buys: Supabase issues an `anon` key with every project, and
-- it ends up in client bundles, browser devtools and screenshot posts by accident.
-- With no RLS, that key can read every table here - including device_settings,
-- which holds exchange API keys and live-trading consent for every user on the
-- deployment. With RLS enabled and no policy defined, that key reads nothing.
--
-- So this is protection against a *leaked public key*. It is NOT per-device
-- authorisation: the backend does that itself, filtering on device_id. Be
-- clear-eyed that a device_id is a header value, not an authenticated identity -
-- that is the existing threat model and this file does not change it.
--
-- There are deliberately NO policies below. An empty policy set means "deny", and
-- the service role does not need one. If you ever add a policy, remember you are
-- re-opening access to everything it covers. Read it as a security change.

alter table watchlist       enable row level security;
alter table orders          enable row level security;
alter table research_logs   enable row level security;
alter table device_settings enable row level security;
alter table paper_calls     enable row level security;
alter table proposals       enable row level security;
alter table model_registry  enable row level security;

-- Not forced. FORCE ROW LEVEL SECURITY also binds the table owner, which would
-- lock you out of reading your own data in the SQL editor - exactly when you most
-- need to look. ENABLE already covers anon and authenticated, which are the roles
-- that matter, and leaves the service role and the owner working as before.

-- Verify after running. Every row should show rls = t and policies = 0.
--
--   select c.relname,
--          c.relrowsecurity as rls,
--          (select count(*) from pg_policies where tablename = c.relname) as policies
--     from pg_class c
--    where c.relname in ('watchlist','orders','research_logs','device_settings',
--                        'paper_calls','proposals','model_registry')
--    order by 1;
--
-- Then confirm the backend still works: restart it, check GET /api/health reports
-- storage: supabase, and check /api/watchlist returns 200. If either fails, the
-- ── DEX observation store ────────────────────────────────────────────────────
-- Point-in-time DEX snapshots, collected from DexScreener and Helius and joined
-- to price bars BY TIMESTAMP when features are built.
--
-- Two things make this table work rather than poison the model:
--
-- 1. `raw` keeps the full provider payload. If a feature turns out to be
--    mis-derived, the original numbers are still there to rebuild it from.
--    Dropping the raw payload makes a past data-quality bug unrecoverable.
--
-- 2. Deliberately NOT device-scoped. Same reasoning as paper_calls: these are
--    facts about a market, not facts about a user, and every device should be
--    able to train on them.
--
-- The (symbol, ts) index is the important part: features are built by asking
-- "what was true at bar t", so every feature query is a point-in-time lookup.

create table if not exists dex_snapshots (
  id uuid primary key default gen_random_uuid(),
  symbol text not null,
  chain text not null,
  ts timestamptz not null,          -- when this observation was taken
  liquidity_usd numeric,
  volume_usd numeric,               -- volume in the provider's own window
  price_change_5m numeric,
  price_change_1h numeric,
  price_change_24h numeric,
  buys integer,                     -- buy txns in the window
  sells integer,
  price_usd numeric,
  raw jsonb,                        -- full provider payload, kept for rebuilds
  created_at timestamptz default now()
);

-- The feature-lookup shape: newest snapshot at or before a given time.
create index if not exists dex_snapshots_symbol_ts on dex_snapshots (symbol, ts desc);
create index if not exists dex_snapshots_chain_ts  on dex_snapshots (chain, ts desc);

-- Added after the base create: without these, a DEX feature cannot be derived
-- from a historical snapshot without re-fetching, and `liquidity_trend` needs a
-- reference point that is older than the current observation.
alter table dex_snapshots add column if not exists pair_address text;
alter table dex_snapshots add column if not exists dex_id text;
alter table dex_snapshots add column if not exists quote_volume_usd numeric;
alter table dex_snapshots add column if not exists source text;   -- dexscreener | helius

-- Whale / wallet flow. Separate from dex_snapshots because the shape and the
-- cost are different: a wallet event is a discrete transfer of significance,
-- whereas a snapshot is a periodic reading of a pool.
--
-- `wallet` is NOT a user of this app. It is a market participant being observed,
-- exactly as a pool is. No key material, no signing, no wallet handling of any
-- kind is implied or stored here.
create table if not exists whale_flows (
  id uuid primary key default gen_random_uuid(),
  wallet text not null,
  symbol text,
  chain text not null,
  ts timestamptz not null,
  side text,                        -- buy | sell | unknown
  amount_usd numeric,
  token_amount numeric,
  tx_signature text,
  raw jsonb,
  created_at timestamptz default now()
);

create index if not exists whale_flows_wallet_ts on whale_flows (wallet, ts desc);
create index if not exists whale_flows_symbol_ts on whale_flows (symbol, ts desc);

-- Per-wallet rollup so a feature can ask "is this wallet net-buying?" without
-- scanning the raw flow table every time. Rebuilt incrementally by the collector.
create table if not exists whale_profiles (
  wallet text primary key,
  chain text not null,
  first_seen timestamptz,
  last_seen timestamptz,
  trades integer default 0,
  net_usd numeric default 0,        -- signed: net selling is negative
  tokens_seen integer default 0,
  updated_at timestamptz default now()
);

-- Kronos sidecar forecasts. One row per prediction request so realized
-- outcomes can be joined later for fine-tuning, reranking and calibration.
create table if not exists kronos_calls (
  id uuid primary key default gen_random_uuid(),
  device_id text,
  symbol text,
  horizon integer,
  sample_count integer,
  model_version text,
  probability_up numeric,
  confidence numeric,
  signal text,
  entry_price numeric,
  target_price numeric,
  raw jsonb,
  realized_return_pct numeric,   -- filled in by the settlement sweep
  settled_at timestamptz,
  created_at timestamptz default now()
);

create index if not exists kronos_calls_symbol_ts on kronos_calls (symbol, created_at desc);

-- RLS. These are read by the backend's service role like every other table.
-- Enabled and deliberately not forced — see the note above.
alter table dex_snapshots enable row level security;
alter table whale_flows   enable row level security;
alter table whale_profiles enable row level security;
alter table kronos_calls  enable row level security;

-- Add the new tables to the verification query at the top of this section.
--   select c.relname, c.relrowsecurity as rls,
--          (select count(*) from pg_policies where tablename = c.relname) as policies
--     from pg_class c
--    where c.relname in ('watchlist','orders','research_logs','device_settings',
--                        'paper_calls','proposals','model_registry',
--                        'dex_snapshots','whale_flows','whale_profiles','kronos_calls')
--    order by 1;
-- backend is not using the service-role key.
