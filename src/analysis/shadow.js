// Shadow Portfolio — "what if you'd copied them?" backtest.
//
// 100% real inputs: the weights come from official disclosures (13F holdings or
// STOCK Act buys) and the prices are real daily closes from historyRange. This
// is a PAPER/VIRTUAL backtest — no real trades, no advice — so it's honest to
// show "$10,000 → $X". We state the assumptions in the response.
import { db, kv } from '../db.js';
import { historyRange, spyBenchmarkSeries } from '../sources/quotes.js';
import { log, logErr } from '../util.js';

export const SHADOW_BASE = 10000; // USD starting amount

// daily closes for a ticker over ~1y, as a date→close map (real prices).
// Memoized in-process for 10 min — mega caps (AAPL, MSFT…) appear in many
// funds, so warming several shadows would otherwise re-fetch the same series.
const seriesMemo = new Map();
async function closeSeries(ticker) {
  const hit = seriesMemo.get(ticker);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.map;
  let rows;
  try { rows = await historyRange(ticker, '1y'); } catch { return null; }
  if (!rows || rows.length < 40) return null;
  const map = new Map();
  for (const r of rows) if (r.close != null) map.set(String(r.date).slice(0, 10), r.close);
  seriesMemo.set(ticker, { at: Date.now(), map });
  return map;
}

// close on `date`, else the closest earlier trading day within a week
function nearestClose(map, date) {
  if (!map) return null;
  if (map.has(date)) return map.get(date);
  const d = new Date(date + 'T00:00:00Z');
  for (let i = 1; i <= 7; i++) {
    const k = new Date(d.getTime() - i * 864e5).toISOString().slice(0, 10);
    if (map.has(k)) return map.get(k);
  }
  return null;
}

// Backtest an equal-normalized weighted basket over the last ~year.
// weights: [{ ticker, weight, name? }]  (weight need not be normalized)
export async function backtestWeights(weights, base = SHADOW_BASE) {
  // merge share classes that resolve to one ticker (e.g. GOOGL + GOOG → GOOGL)
  const byTicker = new Map();
  for (const w of weights) {
    if (!w.ticker || !(w.weight > 0)) continue;
    const prev = byTicker.get(w.ticker);
    if (prev) prev.weight += w.weight;
    else byTicker.set(w.ticker, { ...w });
  }
  const picks = [...byTicker.values()].sort((a, b) => b.weight - a.weight).slice(0, 12);
  if (!picks.length) return null;

  const series = {};
  for (const w of picks) {
    const s = await closeSeries(w.ticker);
    // need a real ~year of clean daily closes; drop sparse/polluted symbols
    if (s && s.size >= 150) series[w.ticker] = s;
  }
  const held = picks.filter(w => series[w.ticker]);
  if (held.length < 2) return null;

  // renormalize weights across the tickers we actually have prices for
  const wsum = held.reduce((s, w) => s + w.weight, 0);
  for (const w of held) w.norm = w.weight / wsum;

  // common trading-day axis = dates present for every held ticker
  let common = null;
  for (const w of held) {
    const dates = new Set(series[w.ticker].keys());
    common = common ? new Set([...common].filter(d => dates.has(d))) : dates;
  }
  const axis = [...common].sort();
  if (axis.length < 30) return null;
  const t0 = axis[0], tN = axis.at(-1);

  // equity curve: base * Σ wᵢ · closeᵢ(t)/closeᵢ(t0)   (downsampled to ~60 pts)
  const step = Math.max(1, Math.floor(axis.length / 60));
  const curve = [];
  for (let i = 0; i < axis.length; i += step) {
    const d = axis[i];
    let mult = 0;
    for (const w of held) mult += w.norm * (series[w.ticker].get(d) / series[w.ticker].get(t0));
    curve.push({ date: d, value: +(base * mult).toFixed(2) });
  }
  if (curve.at(-1)?.date !== tN) {
    let mult = 0;
    for (const w of held) mult += w.norm * (series[w.ticker].get(tN) / series[w.ticker].get(t0));
    curve.push({ date: tN, value: +(base * mult).toFixed(2) });
  }

  const endValue = curve.at(-1).value;
  const returnPct = ((endValue - base) / base) * 100;

  // per-holding contribution to the total return
  const contributors = held.map(w => {
    const r = series[w.ticker].get(tN) / series[w.ticker].get(t0) - 1;
    return {
      ticker: w.ticker,
      name: w.name ?? w.ticker,
      weight: +(w.norm * 100).toFixed(1),
      stockReturn: +(r * 100).toFixed(1),
      contribution: +(w.norm * r * 100).toFixed(2), // pct points added to portfolio
    };
  }).sort((a, b) => b.contribution - a.contribution);

  // S&P 500 benchmark over the same window (real SPY closes, nearest trading day)
  let benchmark = null;
  try {
    const spy = await spyBenchmarkSeries();
    const p0 = nearestClose(spy, t0), pN = nearestClose(spy, tN);
    if (p0 && pN) {
      benchmark = {
        returnPct: +((pN / p0 - 1) * 100).toFixed(2),
        endValue: +(base * (pN / p0)).toFixed(2),
      };
    }
  } catch { /* benchmark optional */ }

  return {
    base,
    from: t0, to: tN,
    endValue: +endValue.toFixed(2),
    returnPct: +returnPct.toFixed(2),
    holdingsUsed: held.length,
    curve,
    contributors,
    benchmark,
  };
}

// cached wrapper (backtests are heavy — many price fetches)
export async function cachedShadow(cacheKey, weightsFn, base = SHADOW_BASE) {
  const cached = kv.get(`shadow:${cacheKey}`);
  if (cached && Date.now() - cached.at < 12 * 3600 * 1000) return cached.data;
  let data = null;
  try {
    const weights = await weightsFn();
    data = weights?.length ? await backtestWeights(weights, base) : null;
    if (data) data.holdings = weights.slice(0, 12).map(w => ({ ticker: w.ticker, name: w.name, weight: w.weight }));
  } catch (err) {
    logErr('shadow', cacheKey, String(err).slice(0, 120));
  }
  kv.set(`shadow:${cacheKey}`, { at: Date.now(), data });
  if (data) log('shadow', `${cacheKey}: $${base} → $${data.endValue} (${data.returnPct}%)`);
  return data;
}

// top-12 current 13F holdings by value — the weights a fund shadow backtests
export const fundWeightsFor = cik => () => {
  const filing = db.prepare('SELECT id FROM fund_filings WHERE cik = ? ORDER BY filed_at DESC LIMIT 1').get(cik);
  if (!filing) return [];
  return db.prepare(`
    SELECT ticker, value weight, issuer name FROM fund_holdings
    WHERE filing_id = ? AND ticker IS NOT NULL AND value > 0
    ORDER BY value DESC LIMIT 12`).all(filing.id);
};

// keep fund shadows warm for the Wall of Fame — computes the `max` most-stale
// caches per call (the cron loop spreads the work; results are kv-cached 12h)
export async function warmFundShadows({ max = 2 } = {}) {
  const funds = db.prepare('SELECT cik, name FROM funds').all();
  const stale = funds
    .map(f => ({ ...f, at: kv.get(`shadow:fund:${f.cik}`)?.at ?? 0 }))
    .filter(f => Date.now() - f.at > 11 * 3600 * 1000)
    .sort((a, b) => a.at - b.at)
    .slice(0, max);
  for (const f of stale) await cachedShadow(`fund:${f.cik}`, fundWeightsFor(f.cik));
  return stale.length;
}
