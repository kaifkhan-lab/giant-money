// Corporate insider trades — parsed live from official SEC EDGAR Form 4 filings.
import { XMLParser } from 'fast-xml-parser';
import { db } from '../db.js';
import { fetchSEC, log, logErr } from '../util.js';

const parser = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true });
const attrParser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });

const CURRENT_FEED =
  'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4&company=&dateb=&owner=include&count=100&output=atom';

function asArray(x) {
  return x == null ? [] : Array.isArray(x) ? x : [x];
}

// Candidate Form 4 filings from the live EDGAR "current events" feed.
async function currentForm4Candidates() {
  const xml = await fetchSEC(CURRENT_FEED, { json: false });
  const doc = attrParser.parse(xml);
  const entries = asArray(doc?.feed?.entry);
  const out = [];
  for (const e of entries) {
    const href = asArray(e.link).map(l => l?.['@_href']).find(Boolean) ?? '';
    // href: https://www.sec.gov/Archives/edgar/data/{cik}/{accNoDashes}/{acc}-index.htm
    const m = String(href).match(/edgar\/data\/(\d+)\/\d+\/([\d-]+)-index/);
    if (!m) continue;
    out.push({ cik: m[1], accession: m[2], filedAt: Date.parse(e.updated ?? '') || Date.now() });
  }
  return out;
}

// Fallback / backfill: EDGAR daily index (full list of the day's filings).
async function dailyIndexForm4Candidates(daysBack = 0) {
  const d = new Date(Date.now() - daysBack * 24 * 3600 * 1000);
  const y = d.getUTCFullYear();
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  const ymd = d.toISOString().slice(0, 10).replace(/-/g, '');
  const url = `https://www.sec.gov/Archives/edgar/daily-index/${y}/QTR${q}/form.${ymd}.idx`;
  const text = await fetchSEC(url, { json: false });
  const out = [];
  for (const line of text.split('\n')) {
    if (!/^4\s{2,}/.test(line)) continue; // exactly form type "4"
    const m = line.match(/(edgar\/data\/(\d+)\/([\d-]+)\.txt)\s*$/);
    if (!m) continue;
    out.push({ accession: m[3], cik: m[2], filedAt: d.getTime() });
  }
  return out;
}

function folderUrl(cik, accession) {
  return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g, '')}`;
}

// Resolve accession -> CIK via EDGAR when the feed didn't include one.
async function resolveFolder(accession) {
  // The atom feed id has no CIK; use the full-text-search API to resolve it.
  const data = await fetchSEC(
    `https://efts.sec.gov/LATEST/search-index?q=%22${accession}%22&forms=4`
  ).catch(() => null);
  const hit = data?.hits?.hits?.[0];
  const cik = hit?._source?.cik ?? asArray(hit?._source?.ciks)[0];
  return cik ? folderUrl(cik, accession) : null;
}

async function parseForm4(cik, accession, filedAt) {
  const folder = cik ? folderUrl(cik, accession) : await resolveFolder(accession);
  if (!folder) throw new Error('cannot resolve filing folder');
  const index = await fetchSEC(`${folder}/index.json`);
  const files = index?.directory?.item ?? [];
  const xmlFile = files.find(f => /\.xml$/i.test(f.name) && !/index/i.test(f.name));
  if (!xmlFile) throw new Error('no xml document in filing');
  const xml = await fetchSEC(`${folder}/${xmlFile.name}`, { json: false });
  const doc = parser.parse(xml)?.ownershipDocument;
  if (!doc) throw new Error('not an ownership document');

  const issuer = doc.issuer ?? asArray(doc.issuer)[0];
  const owner = asArray(doc.reportingOwner)[0];
  const rel = owner?.reportingOwnerRelationship ?? {};
  const name = owner?.reportingOwnerId?.rptOwnerName ?? 'Unknown';
  const title =
    rel.officerTitle && String(rel.officerTitle).trim() ? String(rel.officerTitle).trim()
    : Number(rel.isDirector) ? 'Director'
    : Number(rel.isTenPercentOwner) ? '10% Owner'
    : Number(rel.isOfficer) ? 'Officer'
    : 'Other';

  const txns = asArray(doc.nonDerivativeTable?.nonDerivativeTransaction);
  const rows = [];
  for (const t of txns) {
    const code = t?.transactionCoding?.transactionCode;
    if (code !== 'P' && code !== 'S') continue; // open-market purchases & sales only
    const shares = Number(t?.transactionAmounts?.transactionShares?.value ?? NaN);
    const price = Number(t?.transactionAmounts?.transactionPricePerShare?.value ?? NaN);
    const date = t?.transactionDate?.value ?? null;
    if (!shares || !date) continue;
    rows.push({
      code,
      side: code === 'P' ? 'Buy' : 'Sell',
      shares,
      price: isFinite(price) ? price : null,
      value: isFinite(price) ? shares * price : null,
      trade_date: String(date).slice(0, 10),
    });
  }
  return {
    cik: String(doc.issuer?.issuerCik ?? cik ?? '').replace(/^0+/, ''),
    company: issuer?.issuerName ?? 'Unknown',
    ticker: String(issuer?.issuerTradingSymbol ?? '').toUpperCase().replace(/[^A-Z.]/g, '') || null,
    insider_name: name,
    insider_title: title,
    filedAt,
    rows,
  };
}

const markProcessed = db.prepare(
  'INSERT OR REPLACE INTO processed_filings (accession, form, status, processed_at) VALUES (?, ?, ?, ?)'
);
const isProcessed = db.prepare('SELECT 1 FROM processed_filings WHERE accession = ?');
const insertTrade = db.prepare(`
  INSERT OR IGNORE INTO insider_trades
    (accession, txn_index, cik, company, ticker, insider_name, insider_title,
     side, code, shares, price, value, trade_date, filed_at)
  VALUES (@accession, @txn_index, @cik, @company, @ticker, @insider_name, @insider_title,
     @side, @code, @shares, @price, @value, @trade_date, @filed_at)
`);

export async function fetchInsiderTrades({ maxFilings = 40 } = {}) {
  let candidates = [];
  try {
    candidates = await currentForm4Candidates();
  } catch (err) {
    logErr('insiders', 'current feed failed', String(err));
  }
  // If the live feed gave us little (weekends/holidays), backfill from daily indexes.
  if (candidates.length < 20) {
    for (let back = 0; back < 6 && candidates.length < 200; back++) {
      try {
        const day = await dailyIndexForm4Candidates(back);
        candidates = candidates.concat(day);
        if (day.length) log('insiders', `daily index -${back}d: ${day.length} form 4 filings`);
      } catch { /* index for that day doesn't exist (weekend/holiday) */ }
    }
  }

  const fresh = candidates.filter(c => !isProcessed.get(c.accession));
  const batch = fresh.slice(0, maxFilings);
  let trades = 0;
  for (const cand of batch) {
    try {
      const parsed = await parseForm4(cand.cik, cand.accession, cand.filedAt);
      let i = 0;
      for (const row of parsed.rows) {
        const res = insertTrade.run({
          accession: cand.accession,
          txn_index: i++,
          cik: parsed.cik,
          company: parsed.company,
          ticker: parsed.ticker,
          insider_name: parsed.insider_name,
          insider_title: parsed.insider_title,
          filed_at: parsed.filedAt,
          ...row,
        });
        trades += res.changes;
      }
      markProcessed.run(cand.accession, '4', parsed.rows.length ? 'trades' : 'no-open-market-txn', Date.now());
    } catch (err) {
      markProcessed.run(cand.accession, '4', `error: ${String(err).slice(0, 120)}`, Date.now());
    }
  }
  log('insiders', `processed ${batch.length} filings, ${trades} open-market trades (queue: ${fresh.length - batch.length})`);
  return trades;
}
