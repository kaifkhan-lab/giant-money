// US market indexes — live data from Yahoo Finance's chart API, with the
// CNBC public quote service as a live fallback while Yahoo cools down.
import { db } from '../db.js';
import { pctChange, log, logErr } from '../util.js';
import { yahooFetchJSON, yahooCoolingDown } from './yahoo.js';
import { cnbcQuotes, CNBC_INDEX_MAP } from './cnbc.js';

export const INDEXES = [
  { symbol: '^GSPC', name: 'S&P 500' },
  { symbol: '^IXIC', name: 'Nasdaq Composite' },
  { symbol: '^DJI', name: 'Dow Jones Industrial Average' },
  { symbol: '^RUT', name: 'Russell 2000' },
  { symbol: '^DWCF', name: 'Total US Stock Market (DJ US TSM)' },
];
// retire renamed index rows from older databases
db.prepare("DELETE FROM market_indexes WHERE symbol = '^W5000'").run();

// Regular NYSE/Nasdaq session: 9:30–16:00 ET, Mon–Fri (holidays not modeled).
export function usMarketOpenNow() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false,
  }).formatToParts(new Date()).reduce((a, p) => ({ ...a, [p.type]: p.value }), {});
  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') return false;
  const mins = Number(parts.hour) * 60 + Number(parts.minute);
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}

export async function fetchChart(symbol, range = '3mo', interval = '1d') {
  const data = await yahooFetchJSON(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false`
  );
  const result = data?.chart?.result?.[0];
  if (!result?.meta) throw new Error(`no chart data for ${symbol}`);
  return result;
}

function marketState(meta) {
  // Prefer Yahoo's own field when present, else derive from the regular session window.
  if (meta.marketState) {
    return ['REGULAR'].includes(meta.marketState) ? 'Open' : 'Closed';
  }
  const reg = meta.currentTradingPeriod?.regular;
  if (reg?.start && reg?.end) {
    const t = Math.floor(Date.now() / 1000);
    return t >= reg.start && t < reg.end ? 'Open' : 'Closed';
  }
  return 'Unknown';
}

function closesFrom(result) {
  const ts = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  const rows = [];
  for (let i = 0; i < ts.length; i++) {
    if (closes[i] != null) rows.push({ ts: ts[i], close: closes[i] });
  }
  return rows;
}

const upsertIndex = db.prepare(`
  INSERT INTO market_indexes (symbol, name, price, change_1d, change_1w, change_1m, market_state, updated_at)
  VALUES (@symbol, @name, @price, @change_1d, @change_1w, @change_1m, @market_state, @updated_at)
  ON CONFLICT(symbol) DO UPDATE SET
    name=excluded.name, price=excluded.price, change_1d=excluded.change_1d,
    change_1w=COALESCE(excluded.change_1w, market_indexes.change_1w),
    change_1m=COALESCE(excluded.change_1m, market_indexes.change_1m),
    market_state=excluded.market_state, updated_at=excluded.updated_at
`);
const saveClose = db.prepare(
  'INSERT OR REPLACE INTO price_history (symbol, date, close) VALUES (?, ?, ?)'
);
const saveIndexOHLC = db.prepare(`
  INSERT INTO price_history (symbol, date, open, high, low, close) VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(symbol, date) DO UPDATE SET
    open=excluded.open, high=excluded.high, low=excluded.low, close=excluded.close
`);
const nthCloseBack = db.prepare(`
  SELECT close FROM price_history WHERE symbol = ? ORDER BY date DESC LIMIT 1 OFFSET ?
`);

async function updateIndexesFromYahoo(pending) {
  let ok = 0;
  for (const idx of [...pending]) {
    // Yahoo rate-limits hard. Once the first symbol trips the cooldown there is
    // no point walking the rest — each would only throw the same cooldown error
    // and spam the log. Stop here and let the CNBC fallback fill everything in.
    if (yahooCoolingDown()) break;
    let result;
    try {
      // 1y so one good Yahoo window permanently backfills a full year of daily bars
      result = await fetchChart(idx.symbol, '1y', '1d');
    } catch (err) {
      // A 429 is an expected, fully-handled condition: CNBC covers these indexes
      // right after. Report it as info so real failures stay visible in the log.
      const rateLimited = /429|cooldown/i.test(String(err));
      const note = (where, e) => rateLimited
        ? log('indexes', `${where} rate-limited by Yahoo — using CNBC fallback`)
        : logErr('indexes', where, String(e));
      if (!idx.fallback) { note(idx.symbol, err); continue; }
      try { result = await fetchChart(idx.fallback, '1y', '1d'); }
      catch (err2) { note(idx.symbol, err2); continue; }
    }
    const meta = result.meta;
    const rows = closesFrom(result);
    const price = meta.regularMarketPrice ?? rows.at(-1)?.close;
    if (price == null) continue;

    const closes = rows.map(r => r.close);
    const lastIdx = closes.length - 1;
    const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? closes[lastIdx - 1];
    const weekAgo = closes[Math.max(0, lastIdx - 5)];
    const monthAgo = closes[Math.max(0, lastIdx - 21)];

    // store full daily OHLC (real candles for the index chart)
    const q = result.indicators?.quote?.[0] || {};
    const ts = result.timestamp || [];
    const tx = db.transaction(() => {
      for (let i = 0; i < ts.length; i++) {
        if (q.close?.[i] == null) continue;
        const date = new Date(ts[i] * 1000).toISOString().slice(0, 10);
        if (q.open?.[i] != null && q.high?.[i] != null && q.low?.[i] != null) {
          saveIndexOHLC.run(idx.symbol, date, q.open[i], q.high[i], q.low[i], q.close[i]);
        } else {
          saveClose.run(idx.symbol, date, q.close[i]);
        }
      }
    });
    tx();
    upsertIndex.run({
      symbol: idx.symbol,
      name: idx.name,
      price,
      change_1d: pctChange(prevClose, price),
      change_1w: pctChange(weekAgo, price),
      change_1m: pctChange(monthAgo, price),
      market_state: marketState(meta),
      updated_at: Date.now(),
    });
    pending.delete(idx);
    ok++;
  }
  return ok;
}

async function updateIndexesFromCNBC(pending) {
  const bySymbol = new Map([...pending].map(idx => [CNBC_INDEX_MAP[idx.symbol], idx]));
  const quotes = await cnbcQuotes([...bySymbol.keys()]);
  let ok = 0;
  for (const [cnbcSym, q] of quotes) {
    const idx = bySymbol.get(cnbcSym);
    if (!idx || q.price == null) continue;
    // one clean daily bar per index (date-only key), not a per-minute snapshot
    if (q.asOfDate) saveClose.run(idx.symbol, String(q.asOfDate).slice(0, 10), q.price);
    // weekly/monthly change from our own accumulated close history
    const weekAgo = nthCloseBack.get(idx.symbol, 5)?.close;
    const monthAgo = nthCloseBack.get(idx.symbol, 21)?.close;
    upsertIndex.run({
      symbol: idx.symbol,
      name: idx.name,
      price: q.price,
      change_1d: q.changePct ?? pctChange(q.prevClose, q.price),
      change_1w: pctChange(weekAgo, q.price),
      change_1m: pctChange(monthAgo, q.price),
      market_state: usMarketOpenNow() ? 'Open' : 'Closed',
      updated_at: Date.now(),
    });
    pending.delete(idx);
    ok++;
  }
  return ok;
}

export async function updateIndexes() {
  const pending = new Set(INDEXES);
  let ok = 0;
  if (!yahooCoolingDown()) {
    ok += await updateIndexesFromYahoo(pending);
  }
  if (pending.size) {
    try {
      const n = await updateIndexesFromCNBC(pending);
      if (n) log('indexes', `${n} via CNBC fallback`);
      ok += n;
    } catch (err) {
      logErr('indexes', 'cnbc fallback', String(err).slice(0, 120));
    }
  }
  log('indexes', `updated ${ok}/${INDEXES.length}`);
  return ok;
}
