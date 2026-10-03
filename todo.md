# Beast-Trader Development Checklist

## Safety infrastructure
- [x] Supabase-backed model registry (survives Render spin-down)
- [x] paper_calls + model_registry in the schema, with migrations
- [x] Orders as a second training source (features, exit, pnl_pct, settled_at)
- [x] Order settling wired into the poller (settleOrders)
- [x] paper_calls readable across all devices for the shared model
- [x] Global + per-chain circuit breaker (drawdown, loss streak, stale data)
- [x] Trade gate: one chokepoint for every order path
- [x] maybeAutoTrade routed through the gate (was bypassing it entirely)
- [x] Per-chain risk profiles with liquidity floors and confidence bars
- [x] Auto-executor across 8 chains, every 10 minutes
- [x] Live-readiness checklist gating the mode switch
- [x] CCXT exchange layer, lazy-loaded, sandbox-by-default, no withdrawal path
- [x] Forecast ensemble (Holt-Winters + drift null model + mean reversion)
- [x] Model scoreboard ranking every model on identical outcomes
- [x] 3-day evidence-age floor on promotion
- [x] Basket P&L fix (cross-sectional compounding)

## Validation - still outstanding
- [ ] Ensemble shows positive edge (currently 49.5%, confidence anti-correlated)
- [ ] Verify edge is not an artifact of the noiseMult filter
- [ ] A model passes the promotion gate
- [ ] Two weeks of paper trading with positive expectancy after fees

## Deploy
- [x] render.yaml blueprint
- [x] UptimeRobot documented (5-min interval vs 15-min spin-down)
- [x] Deploy runbook with per-step verification
- [ ] Create the Supabase project and run the schema
- [ ] GitHub push (repo is still entirely untracked)
- [ ] Deploy backend to Render
- [ ] Deploy frontend to Vercel with VITE_API_URL
- [ ] Point UptimeRobot at /api/health
- [ ] Frontend screens: scoreboard, chain status, live readiness

## Security checklist before any live key
- [ ] API keys created with withdrawals DISABLED
- [ ] Keys IP-restricted to Render egress
- [ ] Spot only, no leverage
- [ ] MAX_ORDER_USD left trivial for the first live run
- [ ] Secrets confirmed absent from git history
