// Free, keyless macro and calendar feeds.
//
//   Treasury yield curve  home.treasury.gov  (official, daily XML)
//   IPO calendar          api.nasdaq.com     (priced + newly filed S-1s)
//   Dividend calendar     api.nasdaq.com     (ex-dates and payouts)
//   Crypto reference      api.coingecko.com  (BTC/ETH, for context only)
//
// These datasets are small and slow-moving, so they live in kv as JSON rather
// than earning their own tables. Every payload carries the date it refers to.
import { kv } from '../db.js';
import { fetchJSON, fetchText, log, logErr } from '../util.js';

const NASDAQ_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  accept: 'application/json, text/plain, */*',
};

// ── US Treasury yield curve ────────────────────────────────────────────────
// The 2-year vs 10-year spread is the single most-watched recession signal:
// when it is negative the curve is "inverted".
export async function fetchYieldCurve() {
  const year = new Date().getFullYear();
  const xml = await fetchText(
    `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value=${year}`,
    { timeout: 30000 }
  );
  const entries = xml.match(/<m:properties>([\s\S]*?)<\/m:properties>/g) ?? [];
  if (!entries.length) throw new Error('yield curve: no entries');

  const pick = (block, field) => {
    const m = block.match(new RegExp(`<d:${field}[^>]*>([^<]*)<`));
    const v = m ? Number(m[1]) : NaN;
    return Number.isFinite(v) ? v : null;
  };
  const last = entries.at(-1);
  const date = (last.match(/<d:NEW_DATE[^>]*>([^<]*)</)?.[1] ?? '').slice(0, 10);
  const curve = {
    '1M': pick(last, 'BC_1MONTH'), '3M': pick(last, 'BC_3MONTH'), '6M': pick(last, 'BC_6MONTH'),
    '1Y': pick(last, 'BC_1YEAR'), '2Y': pick(last, 'BC_2YEAR'), '5Y': pick(last, 'BC_5YEAR'),
    '10Y': pick(last, 'BC_10YEAR'), '20Y': pick(last, 'BC_20YEAR'), '30Y': pick(last, 'BC_30YEAR'),
  };
  // a month ago, for "which way are rates moving"
  const prior = entries[Math.max(0, entries.length - 22)];
  const spread = curve['10Y'] != null && curve['2Y'] != null
    ? Number((curve['10Y'] - curve['2Y']).toFixed(2)) : null;

  const payload = {
    date, curve, spread,
    inverted: spread != null && spread < 0,
    prior: { date: (prior.match(/<d:NEW_DATE[^>]*>([^<]*)</)?.[1] ?? '').slice(0, 10), '10Y': pick(prior, 'BC_10YEAR') },
    updated_at: Date.now(),
  };
  kv.set('yield_curve', payload);
  log('macro', `yield curve ${date}: 2Y ${curve['2Y']}% 10Y ${curve['10Y']}% spread ${spread}`);
  return date;
}

// ── IPO calendar ───────────────────────────────────────────────────────────
export async function fetchIpoCalendar() {
  const month = new Date().toISOString().slice(0, 7);
  const json = await fetchJSON(`https://api.nasdaq.com/api/ipo/calendar?date=${month}`,
    { headers: NASDAQ_HEADERS, timeout: 25000 });
  const d = json?.data ?? {};
  const rowsOf = k => (d[k]?.rows ?? d[k]?.upcomingTable?.rows ?? []) || [];

  const payload = {
    month,
    priced: rowsOf('priced').slice(0, 25).map(r => ({
      symbol: r.proposedTickerSymbol, company: r.companyName,
      exchange: r.proposedExchange, price: r.proposedSharePrice,
      date: r.pricedDate ?? r.dealStatus, shares: r.sharesOffered,
    })),
    filed: rowsOf('filed').slice(0, 25).map(r => ({
      symbol: r.proposedTickerSymbol, company: r.companyName,
      date: r.filedDate, value: r.dollarValueOfSharesOffered,
    })),
    updated_at: Date.now(),
  };
  kv.set('ipo_calendar', payload);
  log('macro', `IPOs: ${payload.priced.length} priced, ${payload.filed.length} newly filed`);
  return payload.priced.length + payload.filed.length;
}

// ── Dividend calendar ──────────────────────────────────────────────────────
export async function fetchDividendCalendar({ days = 10 } = {}) {
  const out = [];
  for (let i = 0; i < days; i++) {
    const date = new Date(Date.now() + i * 86400e3).toISOString().slice(0, 10);
    const dow = new Date(date + 'T12:00:00').getUTCDay();
    if (dow === 0 || dow === 6) continue;
    try {
      const json = await fetchJSON(`https://api.nasdaq.com/api/calendar/dividends?date=${date}`,
        { headers: NASDAQ_HEADERS, timeout: 20000 });
      for (const r of json?.data?.calendar?.rows ?? []) {
        out.push({
          symbol: r.symbol, company: r.companyName, exDate: r.dividend_Ex_Date,
          payDate: r.payment_Date, amount: r.dividend_Rate,
          annual: r.indicated_Annual_Dividend,
        });
      }
    } catch { /* one bad day should not sink the calendar */ }
  }
  kv.set('dividend_calendar', { rows: out.slice(0, 120), updated_at: Date.now() });
  log('macro', `dividends: ${out.length} ex-dates in the next ${days} days`);
  return out.length;
}

// ── Crypto reference prices ────────────────────────────────────────────────
export async function fetchCrypto() {
  const json = await fetchJSON(
    'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd&include_24hr_change=true',
    { timeout: 20000 });
  const map = { bitcoin: 'Bitcoin', ethereum: 'Ethereum', solana: 'Solana' };
  const rows = Object.entries(map)
    .filter(([id]) => json?.[id]?.usd != null)
    .map(([id, name]) => ({ id, name, price: json[id].usd, change_24h: json[id].usd_24h_change ?? null }));
  if (!rows.length) throw new Error('crypto: empty response');
  kv.set('crypto', { rows, updated_at: Date.now() });
  return rows.length;
}

export async function fetchMacro() {
  const parts = [];
  for (const [name, fn] of [
    ['yields', fetchYieldCurve], ['ipos', fetchIpoCalendar],
    ['dividends', fetchDividendCalendar], ['crypto', fetchCrypto],
  ]) {
    try { parts.push(`${name}=${await fn()}`); }
    catch (err) { logErr('macro', name, String(err).slice(0, 110)); parts.push(`${name}=fail`); }
  }
  return parts.join(' ');
}
