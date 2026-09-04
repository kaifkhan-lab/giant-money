// CNBC public quote service — live fallback source when Yahoo is cooling down.
// Returns real quotes for indexes and stocks (batched, keyless).
import { fetchJSON } from '../util.js';

export const CNBC_INDEX_MAP = {
  '^GSPC': '.SPX',
  '^IXIC': '.IXIC',
  '^DJI': '.DJI',
  '^RUT': '.RUT',
  '^DWCF': '.DWCF', // Dow Jones U.S. Total Stock Market
};

const num = s => {
  if (s == null) return null;
  const n = Number(String(s).replace(/[,%+]/g, '').replace(/[−–]/g, '-'));
  return isFinite(n) ? n : null;
};

// Up to ~25 symbols per call.
export async function cnbcQuotes(symbols) {
  if (!symbols.length) return new Map();
  const url =
    'https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=' +
    encodeURIComponent(symbols.join('|')) +
    '&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json';
  const data = await fetchJSON(url, { timeout: 15000, retries: 1 });
  const rows = data?.FormattedQuoteResult?.FormattedQuote ?? [];
  const out = new Map();
  for (const r of Array.isArray(rows) ? rows : [rows]) {
    if (!r?.symbol || r.code !== 0) continue;
    out.set(r.symbol, {
      symbol: r.symbol,
      name: r.name ?? r.shortName ?? r.symbol,
      price: num(r.last),
      prevClose: num(r.previous_day_closing),
      changePct: num(r.change_pct),
      volume: num(r.volume),
      marketStatus: r.curmktstatus === 'REG_MKT' ? 'Open' : 'Closed',
      asOfDate: r.last_time ?? null, // yyyy-mm-dd of the quote
    });
  }
  return out;
}
