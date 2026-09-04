// The real backend loop.
//
// This is NOT a simulated loop and it does not depend on any user being
// connected: node-cron fires these jobs inside the server/worker process
// around the clock. Every run is recorded in the job_runs table so the
// dashboard (and you) can audit that the loop is actually executing.
import cron from 'node-cron';
import { db, kv, recordJob } from './db.js';
import { updateIndexes } from './sources/marketData.js';
import { refreshTrackedQuotes, refreshTickerUniverse, refreshSectors } from './sources/quotes.js';
import { fetchNews, enrichNewsImages } from './sources/news.js';
import { fetchInsiderTrades } from './sources/insiders.js';
import { fetchEarningsCalendar } from './sources/earnings.js';
import { fetchFinra } from './sources/finra.js';
import { fetchMacro } from './sources/macro.js';
import { fetchFundFilings, seedFunds } from './sources/funds.js';
import { fetchPoliticianTrades, updatePoliticianPerformance } from './sources/politicians.js';
import { refreshLegislators, refreshCommittees } from './sources/congress.js';
import { refreshPeople } from './sources/people.js';
import { processNewsQueue, backfillNewsTriage } from './analysis/ai.js';
import { computeScores } from './analysis/score.js';
import { warmFundShadows } from './analysis/shadow.js';
import { log, logErr } from './util.js';

const running = new Set();

function job(name, fn) {
  return async () => {
    if (running.has(name)) return; // overlap guard
    running.add(name);
    const startedAt = Date.now();
    try {
      const result = await fn();
      recordJob(name, 'ok', result != null ? String(result) : null, startedAt);
    } catch (err) {
      logErr('job:' + name, String(err));
      recordJob(name, 'error', String(err).slice(0, 300), startedAt);
    } finally {
      running.delete(name);
    }
  };
}

export const JOBS = {
  // ── the 60-second market loop ────────────────────────────────────────────
  market: job('market', async () => {
    const idx = await updateIndexes();
    const q = await refreshTrackedQuotes(20);
    return `indexes=${idx} quotes=${q}`;
  }),
  // news every 3 minutes, AI summaries + real thumbnails immediately after
  news: job('news', async () => {
    const n = await fetchNews();
    const s = await processNewsQueue({ limit: 8 });
    // one-time catch-up for articles summarized before triage existed; a no-op
    // once every row carries an importance rating
    const t = backfillNewsTriage(400);
    const g = await enrichNewsImages(12);
    return `articles=${n} summarized=${s} triaged=${t} thumbs=${g}`;
  }),
  // SEC Form 4 insider filings every 5 minutes
  insiders: job('insiders', () => fetchInsiderTrades({ maxFilings: 35 })),
  // upcoming earnings dates — a calendar only needs refreshing a few times a day
  earnings: job('earnings', () => fetchEarningsCalendar({ days: 12 })),
  // FINRA short interest + dark-pool volume (both publish on a lag, so twice daily)
  finra: job('finra', () => fetchFinra()),
  // Treasury yields, IPO + dividend calendars, crypto reference prices
  macro: job('macro', () => fetchMacro()),
  // rankings + Giant Money Score every 2 minutes
  scores: job('scores', () => computeScores()),
  // 13F institutional filings every 4 hours (they arrive quarterly)
  funds: job('funds', () => fetchFundFilings({ maxFundsPerRun: 6 })),
  // politician disclosures every 6 hours + performance math
  politicians: job('politicians', async () => {
    const n = await fetchPoliticianTrades();
    const p = await updatePoliticianPerformance();
    return `trades=${n} perf=${p}`;
  }),
  politicianPerf: job('politicianPerf', () => updatePoliticianPerformance()),
  // refresh the SEC ticker universe nightly
  tickers: job('tickers', () => refreshTickerUniverse()),
  // congress member records (party/state/photos) + investor portraits, daily
  congress: job('congress', async () => {
    const n = await refreshLegislators();
    await refreshCommittees().catch(() => {});
    return n;
  }),
  people: job('people', () => refreshPeople()),
  sectors: job('sectors', () => refreshSectors()),
  // keep fund Shadow Portfolios warm (Wall of Fame reads these caches)
  shadowWarm: job('shadowWarm', () => warmFundShadows({ max: 2 })),
};

export function startScheduler() {
  seedFunds();

  cron.schedule('* * * * *', JOBS.market);            // every 60 seconds
  cron.schedule('*/3 * * * *', JOBS.news);            // every 3 minutes
  cron.schedule('*/5 * * * *', JOBS.insiders);        // every 5 minutes
  cron.schedule('*/2 * * * *', JOBS.scores);          // every 2 minutes
  cron.schedule('10 */4 * * *', JOBS.funds);          // every 4 hours
  cron.schedule('25 */6 * * *', JOBS.politicians);    // every 6 hours
  cron.schedule('40 * * * *', JOBS.politicianPerf);   // hourly
  cron.schedule('50 2 * * *', JOBS.tickers);          // nightly
  cron.schedule('45 */6 * * *', JOBS.congress);       // after politician refresh
  cron.schedule('5 3 * * *', JOBS.people);            // daily
  cron.schedule('20 3 * * *', JOBS.sectors);          // daily sector refresh
  cron.schedule('15 */6 * * *', JOBS.earnings);       // earnings calendar, 4x a day
  cron.schedule('35 5,17 * * *', JOBS.finra);         // FINRA publishes on a lag
  cron.schedule('45 */4 * * *', JOBS.macro);          // yields + calendars, 6x a day
  cron.schedule('*/15 * * * *', JOBS.shadowWarm);     // 2 fund shadows per tick

  log('scheduler', 'cron jobs registered — backend loop is live');
  bootstrap(); // async fire-and-forget initial fill
}

// First-run / catch-up sequence so the dashboard has real data immediately.
async function bootstrap() {
  const tickerCount = db.prepare('SELECT COUNT(*) c FROM tickers').get().c;
  if (tickerCount < 1000) await job('tickers', refreshTickerUniverse)();

  await JOBS.market();

  // run the rest concurrently — they hit different hosts
  await Promise.allSettled([
    JOBS.news(),
    (async () => {
      await job('insiders-bootstrap', () => fetchInsiderTrades({ maxFilings: 80 }))();
    })(),
    (async () => { await JOBS.politicians(); await JOBS.congress(); })(),
    JOBS.funds(),
    JOBS.people(),
    JOBS.earnings(),
    JOBS.finra(),
    JOBS.macro(),
  ]);
  const sectored = db.prepare("SELECT COUNT(*) c FROM tickers WHERE sector IS NOT NULL").get().c;
  if (sectored < 1000) await JOBS.sectors();
  await JOBS.scores();
  kv.set('bootstrap_done', Date.now());
  log('scheduler', 'bootstrap complete');
}
