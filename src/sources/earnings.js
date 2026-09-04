// Upcoming earnings dates from Nasdaq's public calendar (keyless).
// This is the only forward-looking dataset on the platform: everything else
// records what already happened, this says what is about to.
import { db } from '../db.js';
import { fetchJSON, log, logErr } from '../util.js';

const URL = 'https://api.nasdaq.com/api/calendar/earnings?date=';

// Nasdaq rejects a bare fetch; it wants a browser-ish UA and a JSON accept.
const HEADERS = {
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  accept: 'application/json, text/plain, */*',
};

const upsert = db.prepare(`
  INSERT INTO earnings_calendar (symbol, date, company, session, eps_forecast, last_eps, updated_at)
  VALUES (@symbol, @date, @company, @session, @eps_forecast, @last_eps, @updated_at)
  ON CONFLICT(symbol, date) DO UPDATE SET
    company=excluded.company, session=excluded.session,
    eps_forecast=excluded.eps_forecast, last_eps=excluded.last_eps,
    updated_at=excluded.updated_at
`);

const isoDay = d => d.toISOString().slice(0, 10);
// "time-pre-market" / "time-after-hours" → something a human can read
const sessionOf = t => /pre-market/i.test(t ?? '') ? 'Before open'
  : /after-hours/i.test(t ?? '') ? 'After close'
  : 'During day';

export async function fetchEarningsCalendar({ days = 10 } = {}) {
  let added = 0;
  const today = new Date();
  for (let i = 0; i < days; i++) {
    const day = new Date(today.getTime() + i * 86400e3);
    const dow = day.getUTCDay();
    if (dow === 0 || dow === 6) continue;         // markets closed
    const date = isoDay(day);
    let rows;
    try {
      const json = await fetchJSON(URL + date, { headers: HEADERS, timeout: 20000, retries: 1 });
      rows = json?.data?.rows;
    } catch (err) {
      logErr('earnings', date, String(err).slice(0, 100));
      continue;
    }
    if (!Array.isArray(rows) || !rows.length) continue;

    const tx = db.transaction(list => {
      for (const r of list) {
        const symbol = String(r.symbol ?? '').toUpperCase().trim();
        if (!/^[A-Z.\-]{1,8}$/.test(symbol)) continue;
        upsert.run({
          symbol, date,
          company: r.name ?? symbol,
          session: sessionOf(r.time),
          eps_forecast: r.epsForecast || null,
          last_eps: r.lastYearEPS || null,
          updated_at: Date.now(),
        });
        added++;
      }
    });
    tx(rows);
  }
  // keep the table forward-looking only
  db.prepare("DELETE FROM earnings_calendar WHERE date < date('now', '-2 day')").run();
  log('earnings', `calendar: ${added} company-dates over the next ${days} days`);
  return added;
}
