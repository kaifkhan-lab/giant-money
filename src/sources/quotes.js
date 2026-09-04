// Live stock quotes, price history and fundamentals.
// Quotes/history: Yahoo Finance chart API (CNBC public quotes as fallback).
// Daily OHLC candles: Nasdaq public historical API (keyless).
// Fundamentals: SEC XBRL company facts.
import { db, kv } from '../db.js';
import { fetchSEC, fetchJSON, pctChange, log, logErr } from '../util.js';
import { fetchChart } from './marketData.js';
import { yahooCoolingDown, yahooChartHistory } from './yahoo.js';
import { cnbcQuotes } from './cnbc.js';

const upsertQuote = db.prepare(`
  INSERT INTO quotes (symbol, name, price, prev_close, change_pct, volume, updated_at)
  VALUES (@symbol, @name, @price, @prev_close, @change_pct, @volume, @updated_at)
  ON CONFLICT(symbol) DO UPDATE SET
    name=excluded.name, price=excluded.price, prev_close=excluded.prev_close,
    change_pct=excluded.change_pct, volume=excluded.volume, updated_at=excluded.updated_at
`);

// close-only upsert (CNBC) — never nulls existing OHLC
const insertHistory = db.prepare(`
  INSERT INTO price_history (symbol, date, close) VALUES (?, ?, ?)
  ON CONFLICT(symbol, date) DO UPDATE SET close = excluded.close
`);
// full OHLC upsert (Yahoo) — powers candlestick charts
const insertOHLC = db.prepare(`
  INSERT INTO price_history (symbol, date, open, high, low, close) VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(symbol, date) DO UPDATE SET
    open = excluded.open, high = excluded.high, low = excluded.low, close = excluded.close
`);

// CNBC-based refresh (batch) — used while Yahoo is cooling down.
export async function refreshQuotesViaCNBC(symbols) {
  const quotes = await cnbcQuotes(symbols);
  let ok = 0;
  for (const [sym, q] of quotes) {
    if (q.price == null) continue;
    upsertQuote.run({
      symbol: sym.toUpperCase(),
      name: q.name,
      price: q.price,
      prev_close: q.prevClose,
      change_pct: q.changePct ?? pctChange(q.prevClose, q.price),
      volume: q.volume,
      updated_at: Date.now(),
    });
    if (q.asOfDate) insertHistory.run(sym.toUpperCase(), q.asOfDate, q.price);
    ok++;
  }
  return ok;
}

export async function refreshQuote(symbol) {
  if (yahooCoolingDown()) {
    const n = await refreshQuotesViaCNBC([symbol]);
    if (!n) throw new Error(`no live quote for ${symbol}`);
    return db.prepare('SELECT * FROM quotes WHERE symbol = ?').get(symbol.toUpperCase());
  }
  const result = await fetchChart(symbol, '1y', '1d');
  const meta = result.meta;
  const price = meta.regularMarketPrice;
  const prev = meta.chartPreviousClose ?? meta.previousClose;
  upsertQuote.run({
    symbol: symbol.toUpperCase(),
    name: meta.longName || meta.shortName || symbol.toUpperCase(),
    price,
    prev_close: prev ?? null,
    change_pct: pctChange(prev, price),
    volume: meta.regularMarketVolume ?? null,
    updated_at: Date.now(),
  });
  // store daily OHLC for the candlestick chart + performance-since-trade math
  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const closes = q.close || [], opens = q.open || [], highs = q.high || [], lows = q.low || [];
  const sym = symbol.toUpperCase();
  const tx = db.transaction(() => {
    for (let i = 0; i < ts.length; i++) {
      if (closes[i] == null) continue;
      const date = new Date(ts[i] * 1000).toISOString().slice(0, 10);
      if (opens[i] != null && highs[i] != null && lows[i] != null) {
        insertOHLC.run(sym, date, opens[i], highs[i], lows[i], closes[i]);
      } else {
        insertHistory.run(sym, date, closes[i]);
      }
    }
  });
  tx();
  return db.prepare('SELECT * FROM quotes WHERE symbol = ?').get(symbol.toUpperCase());
}

export function getQuote(symbol) {
  return db.prepare('SELECT * FROM quotes WHERE symbol = ?').get(symbol.toUpperCase());
}

// ---- Daily OHLC history for candlestick charts (Nasdaq public API) --------

const parseMoney = s => {
  if (s == null) return null;
  const n = Number(String(s).replace(/[$,]/g, ''));
  return isFinite(n) ? n : null;
};

// Ensure ~1y of real daily OHLC exists for a symbol (cached ~6h). No mock data:
// if Nasdaq is unavailable, we keep whatever close-only history we already have.
export async function ensureOHLCHistory(symbol) {
  const sym = symbol.toUpperCase();
  const have = db.prepare(
    'SELECT COUNT(*) c FROM price_history WHERE symbol = ? AND open IS NOT NULL'
  ).get(sym).c;
  const cacheKey = `nasdaq_hist:${sym}`;
  const cached = kv.get(cacheKey);
  if (have >= 40 && cached && Date.now() - cached < 6 * 3600 * 1000) return have;

  const today = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 372 * 864e5).toISOString().slice(0, 10);
  try {
    const data = await fetchJSON(
      `https://api.nasdaq.com/api/quote/${encodeURIComponent(sym)}/historical` +
      `?assetclass=stocks&fromdate=${from}&limit=9999&todate=${today}`,
      { headers: { accept: 'application/json' }, timeout: 20000, retries: 1 }
    );
    const rows = data?.data?.tradesTable?.rows ?? [];
    let n = 0;
    const tx = db.transaction(() => {
      for (const r of rows) {
        const m = String(r.date ?? '').match(/(\d{2})\/(\d{2})\/(\d{4})/);
        const close = parseMoney(r.close);
        if (!m || close == null) continue;
        const date = `${m[3]}-${m[1]}-${m[2]}`;
        const o = parseMoney(r.open), hi = parseMoney(r.high), lo = parseMoney(r.low);
        if (o != null && hi != null && lo != null) insertOHLC.run(sym, date, o, hi, lo, close);
        else insertHistory.run(sym, date, close);
        n++;
      }
    });
    tx();
    kv.set(cacheKey, Date.now());
    log('history', `${sym}: ${n} daily OHLC rows from Nasdaq`);
    return n;
  } catch (err) {
    logErr('history', sym, String(err).slice(0, 100));
    return have;
  }
}

// Real daily OHLC for a chart time-range (1m/6m/1y/3y/5y/max), from Nasdaq's
// keyless historical API. Persists what it fetches; falls back to whatever we
// already have stored if the source is unavailable — never fabricates points.
const RANGE_DAYS = { '1w': 9, '1m': 32, '6m': 190, '1y': 372, '3y': 1115, '5y': 1860, max: 4000 };

// Intraday (today) minute prices from Nasdaq's keyless chart endpoint. Line-only
// (no OHLC per minute); returns [] if unavailable — never fabricated.
export async function intradayHistory(symbol) {
  const sym = symbol.toUpperCase();
  try {
    const data = await fetchJSON(
      `https://api.nasdaq.com/api/quote/${encodeURIComponent(sym)}/chart?assetclass=stocks`,
      { headers: { accept: 'application/json' }, timeout: 15000, retries: 1 }
    );
    const ch = data?.data?.chart ?? [];
    return ch
      .map(p => ({ date: new Date(p.x).toISOString(), open: null, high: null, low: null, close: Number(p.y) }))
      .filter(p => isFinite(p.close));
  } catch (err) {
    logErr('intraday', sym, String(err).slice(0, 100));
    return [];
  }
}

export async function historyRange(symbol, range = '1y') {
  const sym = symbol.toUpperCase();

  // Market indexes (^GSPC …) — Nasdaq's stock endpoint doesn't cover them, so
  // pull real daily bars from Yahoo (via curl) and cache clean daily rows.
  if (sym.startsWith('^')) {
    const yRange = { '1d': '5d', '1w': '1mo', '1m': '3mo', '6m': '6mo', '1y': '1y', '3y': '3y', '5y': '5y', max: 'max' }[range] ?? '1y';
    try {
      const rows = await yahooChartHistory(sym, yRange, range === '1d' ? '15m' : '1d');
      if (rows.length) {
        const tx = db.transaction(() => {
          for (const r of rows) {
            if (r.open != null && r.high != null && r.low != null) insertOHLC.run(sym, r.date, r.open, r.high, r.low, r.close);
            else insertHistory.run(sym, r.date, r.close);
          }
        });
        tx();
        return rows;
      }
    } catch (err) { logErr('history-range', sym, String(err).slice(0, 100)); }
    const days2 = RANGE_DAYS[range] ?? RANGE_DAYS['1y'];
    return db.prepare(
      "SELECT substr(date,1,10) date, open, high, low, close FROM price_history WHERE symbol = ? AND date >= ? GROUP BY substr(date,1,10) ORDER BY date ASC"
    ).all(sym, new Date(Date.now() - days2 * 864e5).toISOString().slice(0, 10));
  }

  if (range === '1d') return intradayHistory(sym);
  const days = RANGE_DAYS[range] ?? RANGE_DAYS['1y'];
  const readStored = () => db.prepare(
    'SELECT date, open, high, low, close FROM price_history WHERE symbol = ? AND date >= ? ORDER BY date ASC'
  ).all(sym, new Date(Date.now() - days * 864e5).toISOString().slice(0, 10));

  const today = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - (days + 5) * 864e5).toISOString().slice(0, 10);
  try {
    const data = await fetchJSON(
      `https://api.nasdaq.com/api/quote/${encodeURIComponent(sym)}/historical` +
      `?assetclass=stocks&fromdate=${from}&limit=9999&todate=${today}`,
      { headers: { accept: 'application/json' }, timeout: 20000, retries: 1 }
    );
    const rows = data?.data?.tradesTable?.rows ?? [];
    const out = [];
    const tx = db.transaction(() => {
      for (const r of rows) {
        const m = String(r.date ?? '').match(/(\d{2})\/(\d{2})\/(\d{4})/);
        const close = parseMoney(r.close);
        if (!m || close == null) continue;
        const date = `${m[3]}-${m[1]}-${m[2]}`;
        const o = parseMoney(r.open), hi = parseMoney(r.high), lo = parseMoney(r.low);
        if (o != null && hi != null && lo != null) { insertOHLC.run(sym, date, o, hi, lo, close); out.push({ date, open: o, high: hi, low: lo, close }); }
        else { insertHistory.run(sym, date, close); out.push({ date, open: null, high: null, low: null, close }); }
      }
    });
    tx();
    if (out.length) return out.sort((a, b) => (a.date < b.date ? -1 : 1));
  } catch (err) {
    logErr('history-range', sym, String(err).slice(0, 100));
  }
  return readStored(); // honest fallback: only what we actually have
}

// S&P 500 benchmark for the Shadow Portfolio. We use SPY (the S&P 500 ETF) from
// Nasdaq's public ETF historical API rather than the ^GSPC index, because that
// endpoint is on the same reliable rails as the stock holdings and doesn't hit
// Yahoo's rate limit. Returns a clean date→close Map of real daily closes.
export async function spyBenchmarkSeries(days = 400) {
  const today = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - (days + 5) * 864e5).toISOString().slice(0, 10);
  try {
    const data = await fetchJSON(
      `https://api.nasdaq.com/api/quote/SPY/historical` +
      `?assetclass=etf&fromdate=${from}&limit=9999&todate=${today}`,
      { headers: { accept: 'application/json' }, timeout: 20000, retries: 1 }
    );
    const rows = data?.data?.tradesTable?.rows ?? [];
    const map = new Map();
    for (const r of rows) {
      const m = String(r.date ?? '').match(/(\d{2})\/(\d{2})\/(\d{4})/);
      const close = parseMoney(r.close);
      if (m && close != null) map.set(`${m[3]}-${m[1]}-${m[2]}`, close);
    }
    return map.size ? map : null;
  } catch (err) {
    logErr('spy-benchmark', String(err).slice(0, 100));
    return null;
  }
}

// Close on/just after a date (trade-date price if the filing didn't include one).
export function closeOnOrAfter(symbol, date) {
  return db.prepare(
    'SELECT close FROM price_history WHERE symbol = ? AND date >= ? ORDER BY date ASC LIMIT 1'
  ).get(symbol.toUpperCase(), date)?.close ?? null;
}

// The set of symbols the platform is currently tracking, from real activity.
export function trackedSymbols(limit = 400) {
  const rows = db.prepare(`
    SELECT ticker FROM (
      SELECT ticker, MAX(filed_at) AS w FROM insider_trades
        WHERE ticker IS NOT NULL AND ticker != '' GROUP BY ticker
      UNION
      SELECT ticker, MAX(updated_at) AS w FROM politician_trades
        WHERE ticker IS NOT NULL AND ticker != '' GROUP BY ticker
      UNION
      SELECT ticker, MAX(id) AS w FROM fund_changes
        WHERE ticker IS NOT NULL AND ticker != '' GROUP BY ticker
    ) GROUP BY ticker ORDER BY MAX(w) DESC LIMIT ?
  `).all(limit);
  return rows.map(r => r.ticker);
}

// Refresh a rotating slice of tracked symbols each cycle (oldest first).
export async function refreshTrackedQuotes(batch = 20) {
  const symbols = trackedSymbols();
  if (!symbols.length) return 0;
  const staleness = db.prepare('SELECT updated_at FROM quotes WHERE symbol = ?');
  const ranked = symbols
    .map(s => ({ s, at: staleness.get(s)?.updated_at ?? 0 }))
    .sort((a, b) => a.at - b.at)
    .slice(0, batch)
    .map(r => r.s);

  // Yahoo blocked → one batched CNBC call covers the whole slice.
  if (yahooCoolingDown()) {
    try {
      const ok = await refreshQuotesViaCNBC(ranked);
      log('quotes', `refreshed ${ok}/${ranked.length} tracked symbols via CNBC`);
      return ok;
    } catch (err) {
      logErr('quotes', 'cnbc batch', String(err).slice(0, 120));
      return 0;
    }
  }
  let ok = 0;
  for (const s of ranked) {
    try {
      await refreshQuote(s);
      ok++;
    } catch (err) {
      logErr('quotes', s, String(err).slice(0, 120));
    }
  }
  log('quotes', `refreshed ${ok}/${ranked.length} tracked symbols`);
  return ok;
}

// ---- SEC ticker/CIK universe --------------------------------------------

export async function refreshTickerUniverse() {
  const data = await fetchSEC('https://www.sec.gov/files/company_tickers.json');
  const rows = Object.values(data);
  const insert = db.prepare('INSERT OR REPLACE INTO tickers (ticker, cik, name) VALUES (?, ?, ?)');
  const tx = db.transaction(() => {
    for (const r of rows) {
      insert.run(r.ticker.toUpperCase(), String(r.cik_str).padStart(10, '0'), r.title);
    }
  });
  tx();
  log('tickers', `universe refreshed: ${rows.length} tickers`);
  return rows.length;
}

// Sector/industry for the whole US universe — one bulk call to Nasdaq's
// public screener (keyless, real classifications).
export async function refreshSectors() {
  const data = await fetchJSON(
    'https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=25000&download=true',
    { timeout: 60000, retries: 1, headers: { accept: 'application/json' } }
  );
  const rows = data?.data?.rows ?? [];
  const upd = db.prepare('UPDATE tickers SET sector = ?, industry = ? WHERE ticker = ?');
  let n = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      if (!r?.symbol || !r?.sector) continue;
      n += upd.run(String(r.sector), String(r.industry ?? ''), String(r.symbol).toUpperCase()).changes;
    }
  });
  tx();
  log('sectors', `sector/industry set for ${n} tickers`);
  return n;
}

export function tickerInfo(symbol) {
  return db.prepare('SELECT * FROM tickers WHERE ticker = ?').get(symbol.toUpperCase());
}

export function isKnownTicker(symbol) {
  return !!tickerInfo(symbol);
}

// ---- Fundamentals from SEC XBRL company facts (real filings, no key) -----

function latestFact(facts, keys, units = ['USD']) {
  // companies switch XBRL tags over time — evaluate every candidate tag and
  // keep whichever reported period ends most recently
  let best = null;
  for (const key of keys) {
    const fact = facts?.[key];
    if (!fact) continue;
    for (const unit of units) {
      for (const v of fact.units?.[unit] ?? []) {
        if (v?.val == null) continue;
        if (v.form && v.form !== '10-K' && v.form !== '10-Q') continue;
        if (!best || v.end > best.end) {
          best = { value: v.val, end: v.end, form: v.form, fy: v.fy, fp: v.fp };
        }
      }
    }
  }
  return best;
}

export async function fundamentals(symbol) {
  const info = tickerInfo(symbol);
  if (!info) return null;
  const cacheKey = `facts2:${info.cik}`;
  const cached = kv.get(cacheKey);
  if (cached && Date.now() - cached.at < 6 * 3600 * 1000) return cached.data;

  let data = null;
  try {
    const facts = await fetchSEC(`https://data.sec.gov/api/xbrl/companyfacts/CIK${info.cik}.json`);
    const gaap = facts?.facts?.['us-gaap'];
    const dei = facts?.facts?.dei;
    const revenue = latestFact(gaap, [
      'RevenueFromContractWithCustomerExcludingAssessedTax',
      'Revenues',
      'RevenueFromContractWithCustomerIncludingAssessedTax',
      'SalesRevenueNet',
    ]);
    const netIncome = latestFact(gaap, ['NetIncomeLoss', 'ProfitLoss']);
    const shares = latestFact(dei, ['EntityCommonStockSharesOutstanding'], ['shares']);
    data = {
      entityName: facts?.entityName ?? info.name,
      cik: info.cik,
      revenue,
      netIncome,
      sharesOutstanding: shares,
    };
    kv.set(cacheKey, { at: Date.now(), data });
  } catch (err) {
    logErr('fundamentals', symbol, String(err));
  }
  return data;
}
