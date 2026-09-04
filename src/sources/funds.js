// Top 1% capital — billionaire investors, hedge funds and investment banks.
// Holdings parsed live from official SEC 13F-HR filings (data.sec.gov + EDGAR archives).
import { XMLParser } from 'fast-xml-parser';
import { db, kv } from '../db.js';
import { fetchSEC, fetchJSON, log, logErr } from '../util.js';

// parseTagValue:false — CUSIPs like "92343E106"/"060505104" must stay strings,
// otherwise they get mangled into scientific notation / lose leading zeros
const parser = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true, parseTagValue: false });

// Tracked 13F filers. CIKs are official EDGAR identifiers; a wrong/renamed
// filer simply yields a 404 and is skipped — nothing is fabricated.
export const FUNDS = [
  { cik: '1067983', name: 'Berkshire Hathaway', manager: 'Warren Buffett', wiki: 'Warren Buffett', category: 'billionaire' },
  { cik: '1029160', name: 'Soros Fund Management', manager: 'George Soros', wiki: 'George Soros', category: 'billionaire' },
  { cik: '1536411', name: 'Duquesne Family Office', manager: 'Stanley Druckenmiller', wiki: 'Stanley Druckenmiller', category: 'billionaire' },
  { cik: '921669', name: 'Icahn Capital', manager: 'Carl Icahn', wiki: 'Carl Icahn', category: 'billionaire' },
  { cik: '1336528', name: 'Pershing Square Capital', manager: 'Bill Ackman', wiki: 'Bill Ackman', category: 'billionaire' },
  { cik: '1649339', name: 'Scion Asset Management', manager: 'Michael Burry', wiki: 'Michael Burry', category: 'billionaire' },
  { cik: '1656456', name: 'Appaloosa LP', manager: 'David Tepper', wiki: 'David Tepper', category: 'billionaire' },
  { cik: '1350694', name: 'Bridgewater Associates', manager: 'Ray Dalio (founder)', wiki: 'Ray Dalio', category: 'hedge_fund' },
  { cik: '1037389', name: 'Renaissance Technologies', manager: 'Jim Simons (founder)', wiki: 'Jim Simons', category: 'hedge_fund' },
  { cik: '1423053', name: 'Citadel Advisors', manager: 'Ken Griffin', wiki: 'Kenneth C. Griffin', category: 'hedge_fund' },
  { cik: '1273087', name: 'Millennium Management', manager: 'Izzy Englander', wiki: 'Israel Englander', category: 'hedge_fund' },
  { cik: '1009207', name: 'D.E. Shaw & Co', manager: 'David Shaw (founder)', wiki: 'David E. Shaw', category: 'hedge_fund' },
  { cik: '1179392', name: 'Two Sigma Investments', manager: 'Overdeck / Siegel', wiki: 'Two Sigma', category: 'hedge_fund' },
  { cik: '1040273', name: 'Third Point', manager: 'Dan Loeb', wiki: 'Daniel S. Loeb', category: 'hedge_fund' },
  { cik: '1167483', name: 'Tiger Global Management', manager: 'Chase Coleman', wiki: 'Chase Coleman III', category: 'hedge_fund' },
  { cik: '1135730', name: 'Coatue Management', manager: 'Philippe Laffont', wiki: 'Philippe Laffont', category: 'hedge_fund' },
  { cik: '1061165', name: 'Lone Pine Capital', manager: 'Stephen Mandel (founder)', wiki: 'Stephen Mandel (hedge fund manager)', category: 'hedge_fund' },
  { cik: '1103804', name: 'Viking Global Investors', manager: 'Andreas Halvorsen', wiki: 'Andreas Halvorsen', category: 'hedge_fund' },
  { cik: '1791786', name: 'Elliott Investment Management', manager: 'Paul Singer', wiki: 'Paul Singer (businessman)', category: 'hedge_fund' },
  { cik: '1061768', name: 'Baupost Group', manager: 'Seth Klarman', wiki: 'Seth Klarman', category: 'hedge_fund' },
  { cik: '886982', name: 'Goldman Sachs Group', manager: '—', ticker: 'GS', wiki: 'Goldman Sachs', category: 'investment_bank' },
  { cik: '19617', name: 'JPMorgan Chase', manager: '—', ticker: 'JPM', wiki: 'JPMorgan Chase', category: 'investment_bank' },
  { cik: '895421', name: 'Morgan Stanley', manager: '—', ticker: 'MS', wiki: 'Morgan Stanley', category: 'investment_bank' },
  { cik: '70858', name: 'Bank of America', manager: '—', ticker: 'BAC', wiki: 'Bank of America', category: 'investment_bank' },
  { cik: '831001', name: 'Citigroup', manager: '—', ticker: 'C', wiki: 'Citigroup', category: 'investment_bank' },
  { cik: '72971', name: 'Wells Fargo', manager: '—', ticker: 'WFC', wiki: 'Wells Fargo', category: 'investment_bank' },
  { cik: '93751', name: 'State Street', manager: '—', ticker: 'STT', wiki: 'State Street Corporation', category: 'investment_bank' },
  { cik: '1390777', name: 'BNY Mellon', manager: '—', ticker: 'BK', wiki: 'BNY Mellon', category: 'investment_bank' },
  // Sovereign wealth funds — only funds that actually file 13F-HR with the SEC
  // (verified on EDGAR). QIA, KIA, GIC, ADIA and HKMA don't file public 13Fs, and
  // China Investment Corp's last 13F is from 2010 — so they are honestly excluded.
  { cik: '1374170', name: 'Norges Bank (Government Pension Fund Global)', manager: '—', wiki: 'Norges Bank Investment Management', category: 'sovereign_wealth', country: 'Norway' },
  { cik: '1767640', name: 'Public Investment Fund (PIF)', manager: '—', wiki: 'Public Investment Fund', category: 'sovereign_wealth', country: 'Saudi Arabia' },
  { cik: '1704268', name: 'Mubadala Investment Company', manager: '—', wiki: 'Mubadala Investment Company', category: 'sovereign_wealth', country: 'United Arab Emirates' },
  { cik: '1814011', name: 'Abu Dhabi Investment Council', manager: '—', wiki: 'Abu Dhabi Investment Council', category: 'sovereign_wealth', country: 'United Arab Emirates' },
  { cik: '1021944', name: 'Temasek Holdings', manager: '—', wiki: 'Temasek', category: 'sovereign_wealth', country: 'Singapore' },
  { cik: '1441689', name: 'Korea Investment Corporation', manager: '—', wiki: 'Korea Investment Corporation', category: 'sovereign_wealth', country: 'South Korea' },
  { cik: '1582681', name: 'Alaska Permanent Fund', manager: '—', wiki: 'Alaska Permanent Fund', category: 'sovereign_wealth', country: 'United States' },
  { cik: '1223779', name: 'Texas Permanent School Fund', manager: '—', wiki: 'Permanent School Fund', category: 'sovereign_wealth', country: 'United States' },
];

function pad(cik) { return String(cik).padStart(10, '0'); }
function asArray(x) { return x == null ? [] : Array.isArray(x) ? x : [x]; }

export function seedFunds() {
  const ins = db.prepare(
    'INSERT OR REPLACE INTO funds (cik, name, category, manager, ticker, country) VALUES (?, ?, ?, ?, ?, ?)'
  );
  for (const f of FUNDS) ins.run(f.cik, f.name, f.category, f.manager, f.ticker ?? null, f.country ?? null);
}

// ---- CUSIP -> ticker mapping ---------------------------------------------

const getCusip = db.prepare('SELECT * FROM cusip_map WHERE cusip = ?');
const setCusip = db.prepare('INSERT OR REPLACE INTO cusip_map (cusip, ticker, name) VALUES (?, ?, ?)');

function normalizeName(name) {
  return String(name).toUpperCase()
    .replace(/\b(INC|CORP|CORPORATION|CO|COMPANY|LTD|PLC|LP|LLC|HOLDINGS?|GROUP|TRUST|SA|NV|AG|CL A|CL B|CLASS [ABC]|COM|NEW|DEL)\b/g, '')
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

let nameIndex = null;
function buildNameIndex() {
  nameIndex = new Map();
  const rows = db.prepare('SELECT ticker, name FROM tickers').all();
  for (const r of rows) {
    const key = normalizeName(r.name);
    if (key && !nameIndex.has(key)) nameIndex.set(key, r.ticker);
  }
}

function tickerByIssuerName(issuer) {
  if (!nameIndex) buildNameIndex();
  const key = normalizeName(issuer);
  return key ? nameIndex.get(key) ?? null : null;
}

// OpenFIGI keyless mapping (rate-limited: batches of 10, few calls per cycle).
async function mapCusipsViaOpenFigi(cusips) {
  const out = new Map();
  const batches = [];
  for (let i = 0; i < cusips.length; i += 10) batches.push(cusips.slice(i, i + 10));
  for (const batch of batches.slice(0, 5)) {
    try {
      const res = await fetchJSON('https://api.openfigi.com/v3/mapping', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(batch.map(c => ({ idType: 'ID_CUSIP', idValue: c, exchCode: 'US' }))),
        retries: 0,
      });
      res.forEach((r, i) => {
        const t = r?.data?.[0]?.ticker;
        if (t) out.set(batch[i], t.replace('/', '.'));
      });
      await new Promise(r => setTimeout(r, 3000)); // keyless: 25 req/min
    } catch (err) {
      logErr('openfigi', String(err));
      break;
    }
  }
  return out;
}

async function resolveTickers(holdings) {
  const unresolved = [];
  for (const h of holdings) {
    const cached = getCusip.get(h.cusip);
    if (cached?.ticker) { h.ticker = cached.ticker; continue; }
    const byName = tickerByIssuerName(h.issuer);
    if (byName) {
      h.ticker = byName;
      setCusip.run(h.cusip, byName, h.issuer);
    } else {
      unresolved.push(h);
    }
  }
  // resolve the biggest unresolved positions via OpenFIGI
  const top = unresolved.sort((a, b) => b.value - a.value).slice(0, 50);
  if (top.length) {
    const mapped = await mapCusipsViaOpenFigi(top.map(h => h.cusip));
    for (const h of top) {
      const t = mapped.get(h.cusip);
      if (t) { h.ticker = t; setCusip.run(h.cusip, t, h.issuer); }
    }
  }
}

// ---- 13F parsing -----------------------------------------------------------

async function latest13Fs(cik, count = 2) {
  const sub = await fetchSEC(`https://data.sec.gov/submissions/CIK${pad(cik)}.json`);
  const recent = sub?.filings?.recent;
  if (!recent) return [];
  const out = [];
  for (let i = 0; i < recent.form.length && out.length < count; i++) {
    if (recent.form[i] === '13F-HR') {
      out.push({
        accession: recent.accessionNumber[i],
        filedAt: recent.filingDate[i],
        period: recent.reportDate[i],
      });
    }
  }
  return out;
}

async function parse13FHoldings(cik, accession) {
  const folder = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g, '')}`;
  const index = await fetchSEC(`${folder}/index.json`);
  const files = asArray(index?.directory?.item);
  const infoFile =
    files.find(f => /infotable/i.test(f.name) && /\.xml$/i.test(f.name)) ||
    files.find(f => /\.xml$/i.test(f.name) && !/primary_doc/i.test(f.name) && !/index/i.test(f.name));
  if (!infoFile) throw new Error('no infotable xml');
  const xml = await fetchSEC(`${folder}/${infoFile.name}`, { json: false });
  const doc = parser.parse(xml);
  const table = doc?.informationTable?.infoTable ?? doc?.infoTable;
  const rows = asArray(table);
  // aggregate by cusip (funds report multiple lots)
  const agg = new Map();
  for (const r of rows) {
    const cusip = String(r?.cusip ?? '').toUpperCase();
    if (!cusip) continue;
    const value = Number(r?.value ?? 0);
    const shares = Number(r?.shrsOrPrnAmt?.sshPrnamt ?? 0);
    const prev = agg.get(cusip) ?? { cusip, issuer: String(r?.nameOfIssuer ?? ''), value: 0, shares: 0, ticker: null };
    prev.value += value;
    prev.shares += shares;
    agg.set(cusip, prev);
  }
  return [...agg.values()];
}

const insertFiling = db.prepare(`
  INSERT OR IGNORE INTO fund_filings (cik, accession, form, period, filed_at, total_value, holdings_count)
  VALUES (?, ?, '13F-HR', ?, ?, ?, ?)
`);
const getFiling = db.prepare('SELECT * FROM fund_filings WHERE accession = ?');
const insertHolding = db.prepare(`
  INSERT INTO fund_holdings (filing_id, cik, cusip, issuer, ticker, value, shares, pct)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertChange = db.prepare(`
  INSERT OR IGNORE INTO fund_changes
    (cik, accession, cusip, issuer, ticker, change_type, old_shares, new_shares, old_value, new_value, filed_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

async function ingestFiling(fund, filing) {
  if (getFiling.get(filing.accession)) return null; // already ingested
  const holdings = await parse13FHoldings(fund.cik, filing.accession);
  const totalValue0 = holdings.reduce((s, h) => s + h.value, 0);
  // Some filers (e.g. Norges Bank, PIF) submit near-empty 13F stubs while the
  // real holdings sit under a confidential-treatment request. Ingesting a stub
  // would show $0 AUM and generate thousands of false "exited" changes — skip
  // it and keep the latest substantive report as current instead.
  if (holdings.length < 2 || totalValue0 <= 0) {
    kv.set(`stub13f:${filing.accession}`, { at: Date.now(), holdings: holdings.length });
    log('funds', `${fund.name}: skipping stub/notice 13F ${filing.accession} (${holdings.length} rows, $${totalValue0})`);
    return null;
  }
  await resolveTickers(holdings);
  const totalValue = totalValue0;
  let filingId;
  const tx = db.transaction(() => {
    insertFiling.run(fund.cik, filing.accession, filing.period, filing.filedAt, totalValue, holdings.length);
    filingId = getFiling.get(filing.accession).id;
    for (const h of holdings) {
      insertHolding.run(
        filingId, fund.cik, h.cusip, h.issuer, h.ticker ?? null,
        h.value, h.shares, totalValue ? (h.value / totalValue) * 100 : null
      );
    }
  });
  tx();
  return { filingId, holdings, totalValue };
}

function computeChanges(fund, latest, previousFilingId, latestFiling) {
  const prevRows = db.prepare('SELECT * FROM fund_holdings WHERE filing_id = ?').all(previousFilingId);
  const prevMap = new Map(prevRows.map(r => [r.cusip, r]));
  const seen = new Set();
  const tx = db.transaction(() => {
    for (const h of latest.holdings) {
      seen.add(h.cusip);
      const prev = prevMap.get(h.cusip);
      let type = null;
      if (!prev) type = 'new';
      else if (h.shares > prev.shares * 1.01) type = 'increased';
      else if (h.shares < prev.shares * 0.99) type = 'reduced';
      if (type) {
        insertChange.run(
          fund.cik, latestFiling.accession, h.cusip, h.issuer, h.ticker ?? prev?.ticker ?? null,
          type, prev?.shares ?? 0, h.shares, prev?.value ?? 0, h.value, latestFiling.filedAt
        );
      }
    }
    for (const prev of prevRows) {
      if (!seen.has(prev.cusip)) {
        insertChange.run(
          fund.cik, latestFiling.accession, prev.cusip, prev.issuer, prev.ticker,
          'closed', prev.shares, 0, prev.value, 0, latestFiling.filedAt
        );
      }
    }
  });
  tx();
}

export async function fetchFundFilings({ maxFundsPerRun = 6 } = {}) {
  seedFunds();
  // rotate: process funds whose latest ingested filing is oldest/missing
  const lastIngested = db.prepare(
    'SELECT cik, MAX(filed_at) AS last FROM fund_filings GROUP BY cik'
  ).all();
  const lastMap = new Map(lastIngested.map(r => [r.cik, r.last]));
  const queue = [...FUNDS].sort((a, b) =>
    String(lastMap.get(a.cik) ?? '') < String(lastMap.get(b.cik) ?? '') ? -1 : 1
  ).slice(0, maxFundsPerRun);

  let ingested = 0;
  for (const fund of queue) {
    try {
      // look a few filings back so a CT/notice stub on top doesn't hide the
      // real latest holdings report underneath it
      const filings = (await latest13Fs(fund.cik, 4))
        .filter(f => !kv.get(`stub13f:${f.accession}`));
      if (!filings.length) continue;

      // walk newest→oldest until the two most recent substantive reports are on record
      const subst = [];
      let newest = null; // newest filing actually ingested this run
      for (const fl of filings) {
        if (subst.length >= 2) break;
        if (getFiling.get(fl.accession)) { subst.push(fl); continue; }
        const res = await ingestFiling(fund, fl); // null for stubs (marked in kv)
        if (res) {
          subst.push(fl);
          if (!newest) newest = { filing: fl, data: res };
          ingested++;
        }
      }
      if (!newest) continue; // already up to date (or only stubs found)

      // position changes only when the new ingest is the current report
      if (subst[0].accession === newest.filing.accession && subst[1]) {
        const prevRow = getFiling.get(subst[1].accession);
        if (prevRow) computeChanges(fund, newest.data, prevRow.id, newest.filing);
      }
      log('funds', `${fund.name}: ingested 13F ${newest.filing.accession} (${newest.data.holdings.length} holdings)`);
    } catch (err) {
      logErr('funds', fund.name, String(err));
    }
  }
  log('funds', `run complete, ${ingested} new filings ingested`);
  return ingested;
}
