# FlowDesk — live crypto order-flow terminal

A single-page terminal that runs entirely in your browser from free public exchange data. No server, no API keys, no login.

**Tabs:** Chart · Heatmap · Footprint · Whales · Vol profile · TPO · Gamma · Tape · L3 events · Futures · Sentiment · **Trade plan** · Guide
**Lines (header):** Plan · Walls (biggest order-book walls with price) · Liq (estimated liquidation clusters with price) · Γ (options gamma levels)
**Mouse:** move over any chart or its price scale to read the exact price and % distance from the current price.
**Key points (every tab):** today's trend (up / down / range and why), who is pushing right now, the ★ key resistance and ★ key support (zones where several sources agree, with fake-wall warnings), and a plain-language "what it means" with the break-above / break-below levels. The same key levels are auto-highlighted on the heatmap, its columns and the charts (toggle: Lines → ★ Key).
**Right panel:** Decision (BUY / SELL / WAIT from the order-flow meters, with trigger levels) + DOM ladder + mini tape.
**Keys:** `1`–`9`, `0` switch tabs · `P` shows / hides the right panel.

## Data sources
| What | Source |
|---|---|
| Order book (5,000 levels, 100 ms diffs), trades, best bid/ask, candles | Binance spot public API (`data-api.binance.vision`, falls back to `api.binance.com`) |
| Funding, open interest, mark price, liquidations, futures trades | Bybit USDT perpetual public websocket |
| Liquidation-map open-interest history | Binance USDT-M futures public REST (optional) |
| Options gamma, walls, max pain | Deribit public API |
| US premium | Coinbase public websocket |

## Run it
- **On your computer:** double-click `index.html`. It works straight from the file.
- **Preview without internet:** open `index.html?demo=1` (synthetic data).
- **Any coin:** `index.html?symbol=ETHUSDT`, or use the picker at top-left.

## Put it on GitHub Pages (free)
1. On github.com click **New repository**, name it e.g. `flowdesk`, set it **Public**, create.
2. Click **Add file → Upload files**, drag in everything from this folder (`index.html`, `css/`, `js/`, `README.md`, `.nojekyll`), click **Commit changes**.
3. Go to **Settings → Pages**, under *Build and deployment* choose **Deploy from a branch**, branch **main**, folder **/ (root)**, **Save**.
4. After about a minute your terminal is live at `https://<your-username>.github.io/flowdesk/`.

To update later, upload the changed files again; Pages redeploys automatically.

## Good to know
- History for the heatmap and L3 events starts when you open the page; refreshing clears it. Whale prints and CVD for the last 8 hours are saved in your browser and survive a refresh. Candles, profiles and TPO load history from the exchange.
- Pulls, icebergs, spoofing and liquidation clusters are inferred from public data, so treat them as context.
- If Binance is blocked on your network the header shows OFFLINE; try another network or the demo.
- Nothing here is financial advice.

## Trade plan tab
**🤖 Auto (on by default):** runs in the background on every tab. It shows *WAITING FOR CONFIRMATION* with a countdown to the next 1h close (daily close for swing) and both trigger levels; when a candle closes beyond a trigger, or the analysis confirms a setup, it creates the trade itself, draws it on the charts (Lines → Plan), pops up a message (and a desktop notification if allowed), then tracks it to the end with the health check. One auto trade per mode at a time; after an auto trade finishes it waits one candle before the next.

Three views: **📂 My trades** (every trade you track stays live — waiting / open / TP1 / done / stopped — with P&L in R and $, and a health check every 15 s: ✅ HOLD, ⚠ TIGHTEN / TAKE PARTIAL, ⛔ CONSIDER CLOSING, with reasons; you can add a trade you already have), **✨ Next plan** (checks your open trades first and warns about conflicts; *Track this plan* freezes the levels and moves it to My trades) and **📜 History** (finished trades, win rate, total R and $). The chart shows open trades as solid lines and the next plan dashed. Trades are saved in your browser per coin.

Combines 12 factors (4h and 1h trend, 1h structure, RSI, VWAP/value area, live order flow, 1h+4h delta, whales over 4h, book walls, fake walls, liquidation clusters, funding/OI, options gamma) into a bias, merges ~25 level sources into price zones, then builds one 1h intraday setup: entry at the strongest nearby zone, stop beyond it (0.6–2× ATR), TP1/TP2 at the next opposing zones. If the factors disagree or reward is under 1.3R it says NO TRADE and shows both conditional plans. Set your account size and risk % for position size. Rules live in `js/planner.js`.

**📅 Swing mode (daily):** setups on daily candles — daily/4h swing highs and lows, last week's high/low, weekly swings, daily EMA50/200, liquidation clusters, options call/put walls, big book walls and round numbers as levels; daily ATR for stops; 4h and weekly trend as context. A swing is only *confirmed* when 7 of 9 checks pass (daily+4h trend agree ★, daily structure ★, strong zone behind the stop ★, weekly not against, today's delta, room to TP1, funding not crowded, liquidation pull, RSI not stretched). It then locks and is tracked; if the page was closed, it catches up from 1h candles. Unfilled limits are cancelled after 3 days. Hold time is days.

**Win probability** (both modes) is measured, not guessed: the same setup type is replayed on past candles (~2.7 years of daily candles for swings, ~40 days of 1h for intraday) and it reports how often TP1 was hit before the stop, the sample size, the break-even rate for the plan's targets and the average result in R. Order-book checks can't be replayed (no book history), so it is a base rate.

## Rules, measurement and limits (Trade plan → 📊 Scorecard)
- **Factor families:** the factors are grouped into Trend, Order flow, Leverage and Liquidity. A direction needs at least 2 families agreeing, 60% of the voting families, and none strongly against. This stops price-derived readings being counted several times.
- **Market type:** each plan is checked against the 1h (or daily) market type. Trend: only trades with the trend. Range: only limits at strong zone edges and sweeps. Chaos (candles over 2.5× normal size): no new trades.
- **Costs:** round-trip fees (set in Rules and limits; 0.1% for perpetuals, 0.2% for spot by default) are taken off every R figure. A plan is rejected when fees exceed 25% of the risk or the first target pays under 1.2R after fees.
- **Breakout filter:** a 1h close beyond a trigger only counts when it clears the level by 0.15 ATR, on at least 1.2× average volume, with candle delta in the same direction.
- **Sweep and reclaim:** a second setup. Price runs through a strong zone by 0.1 ATR or more and closes back inside with a long wick; entry is at market with the stop beyond the sweep.
- **Rules backtest:** replays the candle-based rules on about 6 months of 1h candles, after fees, split into an older 60% and a recent 40%. The exit rule (half at TP1 / all at TP1 / all at TP2) is chosen on the older part; the recent part shows how it held up. Order-book, futures, options and whale readings are not in it.
- **Signal journal:** one signal is recorded at each 1h and daily close, and each time a trade is created, with every factor reading. It is followed to its stop or targets. The Scorecard shows results for confirmed and unconfirmed signals and which factors helped.
- **Learned weights:** after 100 finished signals (then every 50 more) factor weights move between 0.5× and 1.5× according to the journal. Can be switched off.
- **Risk limits:** daily loss limit in R, maximum trades per day, trading hours, and half size when Danger is high. Auto does not open trades while a limit is active.
- **More data:** walls are cross-checked against Bybit and OKX spot books, futures CVD (Bybit perpetual) is a factor, and whale prints, per-minute CVD and wall ages for the last 8 hours survive a page refresh.

The code for all of this is in `js/edge.js`.

## Where to tune things
- `js/metrics.js` → `WEIGHTS` and `OF.verdictFrom()` decide how the Decision panel turns meters into BUY / SELL / WAIT.
- `js/core.js` → `housekeeping()` sets the adaptive whale size (99.5th percentile) and L3 size floor.
- `js/edge.js` → `E.combine()` (family agreement), `E.regime()` (market type), `E.gate()` (cost and market-type rules), `E.breakoutOK()`, `E.detectSweep()`.
