# Beast‑Trader Architecture

## Overview
The system consists of a **frontend** SPA (React, Vercel), a **backend** service (Python or Node.js, Render), and **Supabase** for persistent storage.  All authentication is device‑centric – a UUID‑based JWT signed locally allows the backend to identify the user without a guided login flow.

## Key Components

| Component | Responsibility |
|-----------|---------------|
| **Frontend** | UI for markets, watchlist, execution, and portfolio monitoring. Uses react‑router and context for auth. |
| **WalletConnect** | QR‑scan / deep‑link integration with MetaMask, Phantom, Coinbase, etc. Produces the wallet address and signs the nonce. |
| **JWT** | Device‑ID + wallet address signed with HS256. Acts as auth for all backend calls. |
| **Back‑end** | Exposes REST endpoints protected by JWT, runs Needle research & prediction pipelines, orchestrates order execution via CEX SDKs and DEX RPC. |
| **Supabase** | Tables: `watchlist`, `orders`, `research_logs`. Column‑level encryption for user keys. |
| **Needle** | Runs locally or as a micro‑service, receives market data, outputs structured JSON for the prediction layer. |
| **Prediction Models** | Lightweight TensorFlow Lite / PyTorch models per asset type. Return signal and confidence. |
| **Execution Planner** | Translates prediction into an order‑plan JSON. |
| **Order Executor** | Interacts with Binance SDK / Web3 to place orders. |

## Flow
1. Device opens app → generates UUID if missing.
2. User scans QR with wallet → signature returned → JWT created.
3. Frontend stores JWT and displays UI.
4. User stars a token → entry added to Supabase `watchlist`.
5. Backend polling service pulls market data for each starred token (every N seconds). |
6. Data fed to Needl​e research wrapper → struct JSON. |
7. Prediction model returns signal → Execution Planner builds order‑plan. |
8. Order Executor sends signed transaction via wallet or CEX SDK. |
9. Result logged in `orders` table and broadcast to frontend via WebSocket. |

## Deployment
* **Backend** – Render Cloud (free tier). Uses environment variables for Supabase URL and JWT secret. 
* **Frontend** – Vercel (free tier). Connects to backend via HTTPS. 

---
This spec will be expanded with detailed API contracts, database diagrams, and security considerations as work proceeds.