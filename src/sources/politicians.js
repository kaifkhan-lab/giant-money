// US politician trades — official disclosure sources.
//
// Senate: trade-level data from the Senate Stock Watcher dataset (built from
//   official eFD PTR filings; S3 primary, GitHub mirror fallback), plus
//   Financial Modeling Prep when FMP_API_KEY is set (fresher).
// House: the official House Clerk financial-disclosure index (current-year
//   PTR filings by member, updated daily). The Clerk publishes trade detail
//   only inside scanned PDFs, so House rows are stored as PTR filing records
//   with a link to the official document — never invented trade values.
import { unzipSync } from 'fflate';
import { db } from '../db.js';
import { fetchJSON, sha1, log, logErr } from '../util.js';
import { isKnownTicker, closeOnOrAfter, getQuote, refreshQuote } from './quotes.js';

// Mirror first: the S3 bucket started returning 403 to anonymous reads, while
// the GitHub mirror of the same dataset serves it reliably. S3 is kept as a
// secondary in case public access is restored.
const SENATE_URLS = [
  'https://raw.githubusercontent.com/timothycarambat/senate-stock-watcher-data/master/aggregate/all_transactions.json',
  'https://senate-stock-watcher-data.s3-us-west-2.amazonaws.com/aggregate/all_transactions.json',
];

const insertTrade = db.prepare(`
  INSERT OR IGNORE INTO politician_trades
    (hash, chamber, name, ticker, asset, side, amount, trade_date, disclosure_date, link, updated_at)
  VALUES (@hash, @chamber, @name, @ticker, @asset, @side, @amount, @trade_date, @disclosure_date, @link, @updated_at)
`);

function normSide(type) {
  const t = String(type ?? '').toLowerCase();
  if (t.includes('purchase') || t.includes('buy')) return 'Buy';
  if (t.includes('sale') || t.includes('sell')) return 'Sell';
  if (t.includes('exchange')) return 'Exchange';
  return null;
}

function normDate(d) {
  if (!d) return null;
  const s = String(d).trim();
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  const iso = s.match(/^\d{4}-\d{2}-\d{2}/);
  return iso ? iso[0] : null;
}

function cleanTicker(t) {
  const s = String(t ?? '').toUpperCase().trim();
  if (!s || s === '--' || s === 'N/A' || s.length > 6) return null;
  return isKnownTicker(s) ? s : null;
}

function addRows(rows, chamber, { senator = false } = {}) {
  let added = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      const name = senator ? (r.senator ?? r.name) : (r.representative ?? r.name);
      const side = normSide(r.type);
      const tradeDate = normDate(r.transaction_date);
      if (!name || !side || !tradeDate) continue;
      added += insertTrade.run({
        hash: sha1(`${chamber}|${name}|${r.ticker}|${tradeDate}|${side}|${r.amount}`),
        chamber,
        name: String(name).trim(),
        ticker: cleanTicker(r.ticker),
        asset: String(r.asset_description ?? r.asset ?? '').replace(/<[^>]*>/g, '').slice(0, 200),
        side,
        amount: String(r.amount ?? '').trim(),
        trade_date: tradeDate,
        disclosure_date: normDate(r.disclosure_date) ?? null,
        link: r.ptr_link ?? null,
        updated_at: Date.now(),
      }).changes;
    }
  });
  tx();
  return added;
}

async function fetchSenate() {
  // Try each mirror in turn. A single mirror being down is not an error as long
  // as another one serves the data — only report if every source failed.
  const failures = [];
  for (const url of SENATE_URLS) {
    try {
      const rows = await fetchJSON(url, { timeout: 60000, retries: 1 });
      if (Array.isArray(rows) && rows.length) {
        return addRows(rows.slice(-5000), 'Senate', { senator: true });
      }
      failures.push(`${new URL(url).host}: empty response`);
    } catch (err) {
      failures.push(`${new URL(url).host}: ${String(err).slice(0, 60)}`);
    }
  }
  logErr('politicians', 'senate — all sources failed', failures.join(' | ').slice(0, 200));
  return 0;
}

// ---- House Clerk official index -------------------------------------------

async function fetchHouseClerk() {
  let added = 0;
  const years = [new Date().getFullYear(), new Date().getFullYear() - 1];
  for (const year of years) {
    try {
      const res = await fetch(
        `https://disclosures-clerk.house.gov/public_disc/financial-pdfs/${year}FD.zip`,
        { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(60000) }
      );
      if (!res.ok) continue;
      const zip = unzipSync(new Uint8Array(await res.arrayBuffer()));
      const txtName = Object.keys(zip).find(n => n.endsWith('.txt'));
      if (!txtName) continue;
      const lines = new TextDecoder().decode(zip[txtName]).split('\n');
      const rows = [];
      for (const line of lines.slice(1)) {
        const parts = line.split('\t');
        if (parts.length < 9) continue;
        const [prefix, last, first, , filingType, stateDst, , filingDate, docId] = parts;
        if (filingType?.trim() !== 'P' || !docId?.trim()) continue;
        const id = docId.trim();
        // electronic PTRs live under ptr-pdfs, scanned paper ones under financial-pdfs
        const link = /^2/.test(id)
          ? `https://disclosures-clerk.house.gov/public_disc/financial-pdfs/${year}/${id}.pdf`
          : `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/${year}/${id}.pdf`;
        const date = normDate(filingDate?.trim());
        if (!date) continue;
        rows.push({
          hash: sha1(`House|PTR|${id}`),
          chamber: 'House',
          name: `${first?.trim() ?? ''} ${last?.trim() ?? ''}`.trim(),
          ticker: null,
          asset: `Periodic Transaction Report — trades in official filing (${stateDst?.trim() ?? ''})`,
          side: 'Filing',
          amount: '',
          trade_date: date,
          disclosure_date: date,
          link,
          updated_at: Date.now(),
        });
      }
      const tx = db.transaction(() => {
        for (const r of rows) added += insertTrade.run(r).changes;
      });
      tx();
      log('politicians', `house clerk ${year}: ${rows.length} PTR filings on record`);
    } catch (err) {
      logErr('politicians', `house clerk ${year}`, String(err).slice(0, 120));
    }
  }
  return added;
}

// ---- FMP (optional key, fresher senate/house trade detail) -----------------

async function fetchFMP(chamber) {
  const key = process.env.FMP_API_KEY;
  if (!key) return 0;
  const endpoint = chamber === 'Senate' ? 'senate-trading-rss-feed' : 'senate-disclosure-rss-feed';
  let added = 0;
  try {
    for (let page = 0; page < 3; page++) {
      const rows = await fetchJSON(
        `https://financialmodelingprep.com/api/v4/${endpoint}?page=${page}&apikey=${key}`
      );
      if (!Array.isArray(rows) || !rows.length) break;
      added += addRows(
        rows.map(r => ({
          name: `${r.firstName ?? ''} ${r.lastName ?? ''}`.trim() || r.representative || r.office,
          ticker: r.ticker ?? r.symbol,
          type: r.type,
          transaction_date: r.transactionDate,
          disclosure_date: r.disclosureDate ?? r.dateRecieved ?? r.dateReceived,
          amount: r.amount,
          asset_description: r.assetDescription,
          ptr_link: r.link,
        })),
        chamber
      );
    }
  } catch (err) {
    logErr('politicians', `FMP ${chamber}`, String(err).slice(0, 120));
  }
  return added;
}

export async function fetchPoliticianTrades() {
  const senate = await fetchSenate();
  const house = await fetchHouseClerk();
  const fmp = (await fetchFMP('Senate')) + (await fetchFMP('House'));
  log('politicians', `added senate=${senate} house=${house} fmp=${fmp}`);
  return senate + house + fmp;
}

// Compute performance-since-trade for recent trades with known tickers.
export async function updatePoliticianPerformance({ maxSymbols = 15 } = {}) {
  const rows = db.prepare(`
    SELECT id, ticker, trade_date FROM politician_trades
    WHERE ticker IS NOT NULL AND perf_pct IS NULL AND side IN ('Buy','Sell')
    ORDER BY trade_date DESC LIMIT 120
  `).all();
  if (!rows.length) return 0;

  const symbols = [...new Set(rows.map(r => r.ticker))].slice(0, maxSymbols);
  for (const s of symbols) {
    if (!getQuote(s) || Date.now() - (getQuote(s)?.updated_at ?? 0) > 3600e3) {
      try {
        await refreshQuote(s);
      } catch (err) {
        // A ticker with no live quote (delisted, renamed, or not covered by the
        // provider) is a data gap, not a failure — that trade simply shows "—".
        const noQuote = /no live quote/i.test(String(err));
        if (noQuote) log('pol-perf', `${s}: no live quote — performance left blank`);
        else logErr('pol-perf', s, String(err).slice(0, 100));
      }
    }
  }

  const upd = db.prepare(
    'UPDATE politician_trades SET price_at_trade = ?, perf_pct = ?, updated_at = ? WHERE id = ?'
  );
  let done = 0;
  for (const r of rows) {
    if (!symbols.includes(r.ticker)) continue;
    const base = closeOnOrAfter(r.ticker, r.trade_date);
    const q = getQuote(r.ticker);
    if (base && q?.price) {
      upd.run(base, ((q.price - base) / base) * 100, Date.now(), r.id);
      done++;
    }
  }
  log('politicians', `performance computed for ${done} trades`);
  return done;
}
