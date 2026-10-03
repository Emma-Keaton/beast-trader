# Design System: Beast-Trader
**Project ID:** N/A (hand-authored semantic design system — no Stitch project)
**Reference lineage:** UI arrangement studied from `jasper-trades` (screen-based navigation, token card grids, device-scoped API headers).

## 1. Visual Theme & Atmosphere
"Predator Dark" — a dense, high-contrast trading terminal that feels like a cockpit at night. The mood is **alert, mechanical, and confident**: deep navy-black canvases, glowing teal accents, tabular numerals that snap into aligned columns. Information density is high but never cramped; every price, signal, and badge earns its pixel. The interface defaults to dark mode (traders stare at screens for hours) and gracefully inverts to a "Daylight" mode for bright-room reading. On phones it collapses into a thumb-reachable bottom-tab app; on desktop it breathes into a left-rail cockpit with wide data grids.

## 2. Color Palette & Roles
| Name | Hex | Role |
|---|---|---|
| Abyss Slate (bg base) | `#020617` | Page background — the void the terminal floats in |
| Deep Hull (elevated) | `#0F172A` | Cards, panels, sidebars — raised surfaces |
| Gunmetal Line | `#1E293B` | Hairline borders and dividers on dark surfaces |
| Moon Ink (text) | `#F1F5F9` | Primary text on dark |
| Harbor Fog | `#94A3B8` | Secondary text, captions, muted metadata |
| Predator Teal | `#14B8A6` | Primary brand — primary buttons, active nav, focus rings |
| Predator Teal Deep | `#0D9488` | Button fill / hover states |
| Bull Green | `#22C55E` | Positive deltas, LONG signals, winning trades |
| Bear Red | `#EF4444` | Negative deltas, SHORT signals, stop-outs |
| Alpha Gold | `#F59E0B` | Starred watchlist tokens, confidence ≥ 0.8 badges |
| Plasma Violet | `#8B5CF6` | AI/research artifacts — research notes, model output chips |
| Solana Duotone | `#9945FF` → `#14F195` | Solana-chain badges and DEX route chips (gradient) |
| Daylight Paper (light bg) | `#F8FAFC` | Page background in light mode |
| Daylight Card | `#FFFFFF` | Elevated surfaces in light mode |

Semantic pairs always appear together: gains/bull-green, losses/bear-red, AI/violet, starred/gold. Never use brand teal for up/down semantics — teal is identity, green/red are data.

## 3. Typography Rules
- **Display** — *Space Grotesk*, bold, tight tracking. Page titles (`text-2xl md:text-3xl`), section headers. Confident, slightly mechanical tone.
- **UI / body** — *Inter*, regular→semibold, sizes 12–16px. Captions in Harbor Fog.
- **Numerics** — *JetBrains Mono* with `font-variant-numeric: tabular-nums` (`.tnum`) for every price, quantity, percentage. Columns of numbers must align vertically like a ticker tape.
- Eyebrow labels: 11px uppercase, wide tracking, Predator Teal — used above page titles and on panel headers.

## 4. Component Stylings
- **Buttons:** Pill-shaped (rounded-full). Primary = Predator Teal Deep fill, white text, subtle lift on hover, 2% press-down on click. Secondary = outlined Gunmetal Line on Deep Hull. Ghost = text-only with soft slate wash on hover. Destructive actions wear Bear Red.
- **Cards/Containers:** Generously rounded corners (16px / `rounded-card`), Deep Hull background, 1px Gunmetal Line hairline, whisper-soft diffused shadow (`0 4px 16px -4px rgb(2 6 23 / .5)`). Hover: shadow deepens, card lifts 2px.
- **Token cards:** Square-ish cards in responsive grids (2 cols mobile → 4 cols desktop): symbol in display font, price in tabular mono, 24h delta as a colored pill, star toggle top-right (outline when unstarred, Alpha Gold fill when starred).
- **Signals:** LONG chips Bull Green, SHORT chips Bear Red, research summaries framed in Plasma Violet left-border. Confidence rendered as a small bar + percentage in mono.
- **Inputs/Forms:** Control radius 10px, Deep Hull field background on dark / white on light, Gunmetal border that ignites to teal ring on focus. Secret fields render as password inputs; saved keys are never echoed back in full.
- **Badges:** Pill-shaped, 10px semibold, tinted translucent backgrounds (e.g., Solana gradient chip).
- **Skeletons:** Rounded slate-800 blocks with a slow shimmer while prices load.

## 5. Layout Principles
- **Shell:** Centered content up to `1400px`. Desktop: fixed 240px left rail (brand, nav, wallet chip) + main column. Tablet (md): icon-rail. Mobile (< md): single column + fixed bottom tab bar (5 tabs: Dashboard, Markets, Watchlist, Signals, Settings) with safe-area padding.
- **Grids:** Token grids are `grid-cols-2 sm:grid-cols-3 lg:grid-cols-4`; signal/trade tables become stacked cards below `md`.
- **Spacing:** 4px rhythm; 16px gutters mobile, 24–32px desktop; sections separated by 24–32px vertical air.
- **Breakpoints:** Tailwind defaults — `sm 640 / md 768 / lg 1024 / xl 1280`. Nothing depends on hover for core actions (touch-safe). `prefers-reduced-motion` disables lift/shimmer animations.
- **Feedback:** Live-poll freshness dot (pulses teal when a watchlist tick lands within 35s of the 30s poll cadence); toast for every starred/unstarred, order, and settings save.

## 6. Responsive Contract (all screen sizes)
| Range | Layout |
|---|---|
| < 640px | Bottom tab bar, 2-col token grids, tables→cards, full-width buttons |
| 640–768px | 3-col grids, condensed top header |
| 768–1024px | Icon left-rail, 3-col grids |
| ≥ 1024px | Full text left-rail, 4-col grids, data tables inline |
| ≥ 1440px | Content caps at 1400px, generous side margins |
