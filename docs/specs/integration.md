# Integration Plan

## Backend Services
- **Auth Middleware** – checks JWT, extracts `deviceId` and `walletAddress`.
- **Sub‑service** – `research_service.py` wraps Needle call.
- **Prediction Service** – loads TFLite model per asset type.
- **Executor Service** – two branches: Binance SDK for CEX and Web3.py for DEX.
- **Supabase Proxy** – thin wrapper around Supabase REST; adds encryption for API keys.

## API Endpoint List
| Endpoint | Method | Purpose |
|---------|--------|---------|
| `/api/watchlist` | POST | Add symbol |
| `/api/watchlist` | GET | List all |
| `/api/watchlist/:sym` | DELETE | Remove |
| `/api/research` | POST | Trigger research manually |
| `/api/poll` | GET | Polling stream (Server‑Sent Events/WebSocket) | 

## Auth Flow Diagram
```
Client --> Frontend --> Auth Header (JWT) --> Backend
Backend verifies JWT -> passes request to Service layer
```

## Data Persistence
- **Supabase Tables**  – `watchlist`, `orders`, `research_logs`.
- **Encryption** – `api_key` columns are encrypted using `crypto_secret`.

## Deployment Pipeline
1. **Backend CI** – GitHub Actions build, unit tests, Docker image pushed to Render.
2. **Frontend CI** – Vercel preview deployment.
3. **Post‑deployment** – Smoke tests via scripts that hit all endpoints.

## Monitoring
- Render logs for backend; Vercel logs for frontend.
- Slack webhook for critical errors (configurable via Supabase secret).

---
This integration plan will guide the build of the API layer, service orchestrations, and deployment pipelines.