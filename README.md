# FlowDesk — live crypto order-flow terminal

A single-page terminal that runs entirely in your browser from free public exchange data. No server, no API keys, no login.

**Tabs:** Chart · Heatmap · Footprint · Whales · Vol profile · TPO · Gamma · Tape · L3 events · Futures · Sentiment · Guide
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
- History for the heatmap, L3 events and live whales starts when you open the page and lives only in your browser; refreshing clears it. Candles, profiles and TPO load history from the exchange.
- Pulls, icebergs, spoofing and liquidation clusters are inferred from public data, so treat them as context.
- If Binance is blocked on your network the header shows OFFLINE; try another network or the demo.
- Nothing here is financial advice.

## Where to tune things
- `js/metrics.js` → `WEIGHTS` and `OF.verdictFrom()` decide how the Decision panel turns meters into BUY / SELL / WAIT.
- `js/core.js` → `housekeeping()` sets the adaptive whale size (99.5th percentile) and L3 size floor.
