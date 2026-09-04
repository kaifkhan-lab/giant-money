// FINRA public data: short interest and dark-pool (ATS) volume.
// Both are official, free and keyless — and both are deliberately lagged by
// FINRA, so every figure we store carries the date it actually refers to.
// Nothing here is real-time and the UI must never imply that it is.
import { db } from '../db.js';
import { log, logErr } from '../util.js';

const BASE = 'https://api.finra.org/data/group/otcMarket/name/';

// The API refuses to sort unless every partition key is pinned, so instead of
// asking for "the newest" we ask for a recent window and keep the max date.
async function finraQuery(dataset, body) {
  const res = await fetch(BASE + dataset, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) throw new Error(`FINRA ${dataset} HTTP ${res.status}`);
  // An empty window comes back as a zero-length body, not as "[]" — parsing
  // that as JSON throws, so treat "no text" as "no rows".
  const text = (await res.text()).trim();
  if (!text) return [];
  const json = JSON.parse(text);
  if (!Array.isArray(json)) throw new Error(`FINRA ${dataset}: unexpected shape`);
  return json;
}

const daysAgoISO = n => new Date(Date.now() - n * 86400e3).toISOString().slice(0, 10);
const todayISO = () => new Date().toISOString().slice(0, 10);

// A wide window plus a row limit is a trap: the limit fills up with the OLDEST
// rows in range and the newest publication never arrives. So probe a narrow
// recent window first and only widen it if that window is genuinely empty.
async function fetchNewestWindow(dataset, field, extra = {}, windows = [12, 25, 45, 80]) {
  for (const days of windows) {
    const rows = await finraQuery(dataset, {
      ...extra,
      dateRangeFilters: [{ fieldName: field, startDate: daysAgoISO(days), endDate: todayISO() }],
    });
    if (rows.length) return rows;
  }
  return [];
}

// ── Short interest ─────────────────────────────────────────────────────────
const upsertShort = db.prepare(`
  INSERT INTO short_interest
    (symbol, name, settlement_date, short_shares, prev_short_shares, avg_daily_volume,
     days_to_cover, change_pct, updated_at)
  VALUES (@symbol, @name, @settlement_date, @short_shares, @prev_short_shares, @avg_daily_volume,
          @days_to_cover, @change_pct, @updated_at)
  ON CONFLICT(symbol) DO UPDATE SET
    name=excluded.name, settlement_date=excluded.settlement_date,
    short_shares=excluded.short_shares, prev_short_shares=excluded.prev_short_shares,
    avg_daily_volume=excluded.avg_daily_volume, days_to_cover=excluded.days_to_cover,
    change_pct=excluded.change_pct, updated_at=excluded.updated_at
  WHERE excluded.settlement_date >= short_interest.settlement_date
`);

export async function fetchShortInterest() {
  // short interest settles twice a month and publishes ~8 business days later
  const rows = await fetchNewestWindow('consolidatedShortInterest', 'settlementDate', { limit: 20000 });
  if (!rows.length) { log('finra', 'short interest: no rows in window'); return 0; }

  // keep only the newest settlement present in the response
  const latest = rows.reduce((a, r) => r.settlementDate > a ? r.settlementDate : a, '');
  const fresh = rows.filter(r => r.settlementDate === latest);
  const now = Date.now();

  const tx = db.transaction(list => {
    for (const r of list) {
      const symbol = String(r.symbolCode ?? '').toUpperCase().trim();
      if (!/^[A-Z.\-]{1,8}$/.test(symbol)) continue;
      upsertShort.run({
        symbol,
        name: r.issueName ?? symbol,
        settlement_date: r.settlementDate,
        short_shares: r.currentShortPositionQuantity ?? null,
        prev_short_shares: r.previousShortPositionQuantity ?? null,
        avg_daily_volume: r.averageDailyVolumeQuantity ?? null,
        days_to_cover: r.daysToCoverQuantity ?? null,
        change_pct: r.changePercent ?? null,
        updated_at: now,
      });
    }
  });
  tx(fresh);
  log('finra', `short interest: ${fresh.length} symbols, settled ${latest}`);
  return fresh.length;
}

// ── Dark pool / ATS weekly volume ──────────────────────────────────────────
const upsertDark = db.prepare(`
  INSERT INTO dark_pool (symbol, name, week_start, shares, trades, notional, venues, updated_at)
  VALUES (@symbol, @name, @week_start, @shares, @trades, @notional, @venues, @updated_at)
  ON CONFLICT(symbol) DO UPDATE SET
    name=excluded.name, week_start=excluded.week_start, shares=excluded.shares,
    trades=excluded.trades, notional=excluded.notional, venues=excluded.venues,
    updated_at=excluded.updated_at
  WHERE excluded.week_start >= dark_pool.week_start
`);

export async function fetchDarkPool() {
  // ATS data is weekly and published ~3 weeks late. A multi-week window would
  // hit the row limit on the OLDEST week and never reach the newest, so walk
  // back one week at a time and stop at the first week that has data.
  let rows = [];
  for (let back = 1; back <= 8 && !rows.length; back++) {
    const end = daysAgoISO((back - 1) * 7);
    const start = daysAgoISO(back * 7);
    rows = await finraQuery('weeklySummary', {
      limit: 40000,
      dateRangeFilters: [{ fieldName: 'weekStartDate', startDate: start, endDate: end }],
      compareFilters: [{ fieldName: 'summaryTypeCode', fieldValue: 'ATS_W_SMBL_FIRM', compareType: 'EQUAL' }],
    });
  }
  if (!rows.length) { log('finra', 'dark pool: no rows in window'); return 0; }

  const latest = rows.reduce((a, r) => (r.weekStartDate > a ? r.weekStartDate : a), '');
  const agg = new Map();
  for (const r of rows) {
    if (r.weekStartDate !== latest) continue;
    const symbol = String(r.issueSymbolIdentifier ?? '').toUpperCase().trim();
    if (!/^[A-Z.\-]{1,8}$/.test(symbol)) continue;
    const cur = agg.get(symbol) ?? { name: r.issueName ?? symbol, shares: 0, trades: 0, notional: 0, venues: new Set() };
    cur.shares += Number(r.totalWeeklyShareQuantity) || 0;
    cur.trades += Number(r.totalWeeklyTradeCount) || 0;
    cur.notional += Number(r.totalNotionalSum) || 0;
    if (r.marketParticipantName) cur.venues.add(String(r.marketParticipantName).split(' ')[0]);
    agg.set(symbol, cur);
  }

  const now = Date.now();
  const tx = db.transaction(list => {
    for (const [symbol, v] of list) {
      upsertDark.run({
        symbol, name: v.name, week_start: latest,
        shares: Math.round(v.shares), trades: Math.round(v.trades),
        notional: Math.round(v.notional), venues: v.venues.size, updated_at: now,
      });
    }
  });
  tx([...agg]);
  log('finra', `dark pool: ${agg.size} symbols, week of ${latest}`);
  return agg.size;
}

export async function fetchFinra() {
  let si = 0, dp = 0;
  try { si = await fetchShortInterest(); } catch (err) { logErr('finra', 'short interest', String(err).slice(0, 120)); }
  try { dp = await fetchDarkPool(); } catch (err) { logErr('finra', 'dark pool', String(err).slice(0, 120)); }
  return `shortInterest=${si} darkPool=${dp}`;
}
