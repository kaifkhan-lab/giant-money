# Giant Money — USA Smart Money Intelligence Platform

Track where the most influential money in America is moving — billionaires,
hedge funds, investment banks, sovereign wealth funds and US politicians —
using **only live data**: no mock data, no simulated trades, no placeholders.
If a number isn't available yet, the UI shows a dash, never a fake value.

- **Landing** · `http://localhost:4600/` — "The 200-Year Edge": a cinematic
  scroll story with an ambient animated-SVG film strip (1815 courier ship →
  1815 night rider → 1867 ticker tape → 1981 terminal), hydrated with live
  platform data. The previous marketing landing is preserved at `/classic`.
- **App** · `http://localhost:4600/app` — Dashboard · Top 1% · Politicians ·
  Insiders · Stocks · News · ⚔️ Battles · Watchlist

## Features

- **Dashboard** — live US indexes; Institutional Stock Picks with
  1 Day / Weekly / Monthly tabs (ranked by the Giant Money Score);
  **Wall of Fame / Wall of Shame™** (best politician trader, best hedge fund
  by Shadow-Portfolio return, worst trade, biggest exited-too-early mistake);
  **"Who Bought Before the News?"™** — today's biggest movers matched against
  real insider/fund buys from the prior 14 days.
- **Top 1%** — 36 tracked 13F filers: 💰 Billionaires, 📊 Hedge Funds,
  🏦 Investment Banks (real logos), 👑 **Sovereign Wealth Funds** (Norges Bank,
  Saudi PIF, Mubadala, Abu Dhabi Investment Council, Temasek, KIC, Alaska
  Permanent, Texas PSF — only funds that genuinely file 13F-HR; confidential-
  treatment stub filings are detected and skipped). Holdings, QoQ changes, and
  a **Shadow Portfolio** on every profile: *"if you'd copied them a year ago,
  $10,000 → $X"*, backtested on real prices vs an S&P 500 benchmark.
- **Politicians** — every STOCK Act disclosure with rankings, smart-money
  signals, committees, sector allocation, win rates, monthly activity,
  per-member Shadow Portfolios and government-contract exposure
  (USAspending.gov).
- **Insiders** — live SEC Form 4 feed: CEO/CFO/director buys, 48h cluster
  alerts, buy/sell balance.
- **Stocks** — search any US stock: live quote, 1D–5Y line/candle charts with
  hover crosshair, XBRL fundamentals, smart-money ownership donut, politician
  sentiment, related stocks and news.
- **News** — category chips (US/Earnings/IPO/Deals/Crypto/Economy/World),
  hero + card grid with real thumbnails, AI briefs per story.
- **⚔️ Battles** — challenge a friend with a `GM-XXXXXX` room code: configure
  duration/capital/market/picks, pick stocks (each card shows a live
  smart-money signal), ready-up in a glass waiting room with trash talk,
  3-2-1 countdown, live dual-line scoreboard on **real closing prices**, and
  a canvas-rendered shareable victory card. Paper money only.

## Live data sources

| Data | Source |
|---|---|
| Market indexes & stock quotes | Yahoo Finance chart API, with **CNBC public quotes** as automatic fallback |
| Daily OHLC price history | **Nasdaq public historical API** (stocks + ETFs; SPY powers the S&P benchmark) |
| Insider trades | SEC EDGAR **Form 4** filings (official XML) |
| Institutional holdings | SEC EDGAR **13F-HR** information tables (36 tracked filers) |
| Company fundamentals | SEC **XBRL company facts** |
| Senate trades | Senate eFD PTR dataset (GitHub mirror) |
| House PTR filings | **Official House Clerk** financial-disclosure index |
| Congress members & photos | unitedstates project datasets + official congressional photo archive |
| Government contracts | **USAspending.gov** API |
| Investor portraits & bios | Wikipedia REST API (Wikimedia images) |
| Company logos | Financial Modeling Prep public image CDN |
| News | Yahoo Finance, CNBC, MarketWatch, Seeking Alpha, Business Insider, Google News RSS |
| CUSIP → ticker mapping | SEC ticker universe + OpenFIGI |
| AI news briefs | Anthropic Claude (`ANTHROPIC_API_KEY`) with structured output; labeled local text-analysis fallback without a key |

Optional keys (`.env.example`): `ANTHROPIC_API_KEY` (Claude briefs),
`FMP_API_KEY` (fresher politician trade detail), `SEC_USER_AGENT`, `PORT`.
Please set `SEC_USER_AGENT="YourApp you@example.com"` — SEC's fair-access
policy asks API clients to declare a contact.

## The real backend loop

`src/scheduler.js` registers **node-cron** jobs inside the server (or a
dedicated worker) process. They run 24/7 whether or not anyone is on the site;
every run is recorded in the `job_runs` audit table (`/api/status`, also shown
in the app footer):

| Job | Cadence |
|---|---|
| Market indexes + tracked quotes | **every 60 seconds** |
| News fetch + AI briefs | every 3 minutes |
| SEC Form 4 insider filings | every 5 minutes |
| Giant Money Score + rankings | every 2 minutes |
| SEC 13F fund filings | every 4 hours |
| Politician disclosures (+ House Clerk index) | every 6 hours |
| Politician performance math | hourly |
| Shadow-Portfolio warm-up (Wall of Fame cache) | every 15 minutes |
| Congress member records / committees | every 6 hours |
| SEC ticker universe / investor portraits / sectors | nightly |

Resilience: all Yahoo traffic is serialized, spaced, and guarded by a circuit
breaker (429 → exponential cooldown, max 15 min) — during cooldowns the loop
transparently switches to CNBC quotes so the dashboard stays live. Yahoo
requests go through the system `curl` (HTTP/1.1) because Yahoo's edge rejects
Node's TLS fingerprint.

## Run

```bash
npm install
npm start              # API + scheduler in one process → http://localhost:4600
```

Split deployment (separate web tier and data pipeline):

```bash
npm run worker         # scheduler only
npm run server         # API only (DISABLE_SCHEDULER=1)
```

Production with PM2:

```bash
pm2 start ecosystem.config.cjs
```

The SQLite database (`data/giantmoney.db`, WAL mode) is created and filled
automatically by the scheduler on first boot — the repo ships no data. Filings,
trades, news, scores and the job audit log persist across restarts, so the
platform keeps accumulating history from every loop cycle.

## Architecture

- **Backend** — Node 22, Express 5, better-sqlite3, node-cron.
  `src/sources/*` are the ingestors; `src/analysis/*` holds the Giant Money
  Score, the Shadow-Portfolio backtester and AI briefs; `src/server.js` is the
  API; `src/scheduler.js` is the loop.
- **Frontend** — one vanilla-JS SPA (`public/app.js`, hash routing, zero build
  step) plus self-contained landing pages. Design system: dark `#0a0b0f`,
  DM Serif Display headlines, IBM Plex Mono numerals, green/red/gold accents.
- **Scene system** — `design/scene-template.md` locks the palette, lighting,
  composition and the 7-token ambient-motion system shared by every animated
  SVG scene in `public/assets/`.

## Honesty guarantees

- Every figure originates from a live fetch of an official/public source.
- Shadow Portfolios and Battles are **paper math on real prices** — no real
  trades, ever.
- AI briefs are generated from the real article text; without Claude
  credentials the UI labels summaries as "local analysis".
- House PTR trade details live in scanned PDFs the Clerk publishes; rather than
  invent values, House rows are shown as filing records linking to the official
  document (trade-level detail appears via FMP when a key is provided).

## Disclaimer

Giant Money is an information platform derived from public disclosures
(13F, Form 4, PTR). It is **not investment advice**.
