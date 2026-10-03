# Markets UI

## Components
- **Search** – Input field with debounce that queries the backend for symbol/name suggestions.
- **Token list** – Table showing current price, 24h change, depth chart thumbnail. Each row has a **star** icon to add to watchlist.
- **Watchlist tab** – Shows starred tokens, editable quantity and risk‑limit fields. Clicking *Refresh* triggers a quick poll through the backend.
- **Account** – Wallet connection status, QR scanner, and account balance fetch.

## Interaction Flow
1. User opens `Markets` page.
2. Types in search → helper API (`/api/symbols?q=...`) returns matching tokens.
3. Selecting a token shows a modal with its chart and details.
4. Star icon toggles watchlist state; UI reflects persistence via Supabase.
5. Watchlist items can be disabled or cleared through controls. Auto‑polling runs every **30 seconds** by default; a *Refresh* button triggers an immediate poll (max once per 15 seconds).
6. Token market updates push via WebSocket and update the table in real time.

## Styling
- Uses Tailwind CSS v3.
- Responsive layout: full desktop view, collapsible sidebar on mobile.
- Color palette from OpenAlice branding: dark mode with cyan accents.

## Data Flow
- All actions use the authenticated JWT token.
- The watchlist CRUD endpoints are:
  ```http
  POST /api/watchlist
  GET  /api/watchlist
  DELETE /api/watchlist/:symbol
  ```

## Future Enhancements
- Add charting library (e.g., TradingView Charting Library) for deep technical analysis.
- Provide watchlist alerts via push notifications.