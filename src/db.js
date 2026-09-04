import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// DATA_DIR lets a hosted deployment point the database at a mounted volume, so
// the data survives restarts and redeploys. Locally it defaults to ./data.
const dataDir = process.env.DATA_DIR || join(root, 'data');
mkdirSync(dataDir, { recursive: true });

export const db = new Database(join(dataDir, 'giantmoney.db'));
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.exec(`
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS market_indexes (
  symbol TEXT PRIMARY KEY, name TEXT, price REAL,
  change_1d REAL, change_1w REAL, change_1m REAL,
  market_state TEXT, updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS tickers (
  ticker TEXT PRIMARY KEY, cik TEXT, name TEXT
);

CREATE TABLE IF NOT EXISTS quotes (
  symbol TEXT PRIMARY KEY, name TEXT, price REAL, prev_close REAL,
  change_pct REAL, volume REAL, updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS price_history (
  symbol TEXT, date TEXT, close REAL,
  PRIMARY KEY (symbol, date)
);

CREATE TABLE IF NOT EXISTS news (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guid TEXT UNIQUE, source TEXT, title TEXT, link TEXT,
  published_at INTEGER, raw_summary TEXT,
  ai_summary TEXT, sentiment TEXT, confidence REAL, tickers TEXT, ai_engine TEXT,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_news_pub ON news(published_at DESC);

CREATE TABLE IF NOT EXISTS processed_filings (
  accession TEXT PRIMARY KEY, form TEXT, status TEXT, processed_at INTEGER
);

CREATE TABLE IF NOT EXISTS insider_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  accession TEXT, txn_index INTEGER,
  cik TEXT, company TEXT, ticker TEXT,
  insider_name TEXT, insider_title TEXT,
  side TEXT, code TEXT, shares REAL, price REAL, value REAL,
  trade_date TEXT, filed_at INTEGER,
  UNIQUE (accession, txn_index)
);
CREATE INDEX IF NOT EXISTS idx_insider_ticker ON insider_trades(ticker);
CREATE INDEX IF NOT EXISTS idx_insider_date ON insider_trades(trade_date DESC);

CREATE TABLE IF NOT EXISTS funds (
  cik TEXT PRIMARY KEY, name TEXT, category TEXT, manager TEXT
);

CREATE TABLE IF NOT EXISTS fund_filings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cik TEXT, accession TEXT UNIQUE, form TEXT, period TEXT, filed_at TEXT,
  total_value REAL, holdings_count INTEGER
);

CREATE TABLE IF NOT EXISTS fund_holdings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filing_id INTEGER, cik TEXT, cusip TEXT, issuer TEXT, ticker TEXT,
  value REAL, shares REAL, pct REAL
);
CREATE INDEX IF NOT EXISTS idx_holdings_filing ON fund_holdings(filing_id);
CREATE INDEX IF NOT EXISTS idx_holdings_ticker ON fund_holdings(ticker);

CREATE TABLE IF NOT EXISTS fund_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cik TEXT, accession TEXT, cusip TEXT, issuer TEXT, ticker TEXT,
  change_type TEXT, old_shares REAL, new_shares REAL,
  old_value REAL, new_value REAL, filed_at TEXT,
  UNIQUE (accession, cusip)
);

CREATE TABLE IF NOT EXISTS cusip_map (
  cusip TEXT PRIMARY KEY, ticker TEXT, name TEXT
);

CREATE TABLE IF NOT EXISTS politician_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hash TEXT UNIQUE, chamber TEXT, name TEXT, ticker TEXT, asset TEXT,
  side TEXT, amount TEXT, trade_date TEXT, disclosure_date TEXT,
  price_at_trade REAL, perf_pct REAL, updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_pol_date ON politician_trades(trade_date DESC);

CREATE TABLE IF NOT EXISTS scores (
  ticker TEXT PRIMARY KEY, name TEXT, score REAL, components TEXT,
  insider_sentiment TEXT, updated_at INTEGER
);

-- Accounts. The password is never stored — only a scrypt hash and its salt.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,          -- always stored lower-cased
  name TEXT,
  pw_hash TEXT NOT NULL,
  pw_salt TEXT NOT NULL,
  photo TEXT,
  created_at INTEGER,
  last_login INTEGER
);

-- Sessions hold a HASH of the cookie token, so a leaked database still cannot
-- be replayed as a login. Rows are deleted on logout and on expiry.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at INTEGER,
  expires_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- Per-account data, so a signed-in user gets the same watchlist, portfolio and
-- alerts on any device instead of whatever this browser happens to remember.
CREATE TABLE IF NOT EXISTS user_data (
  user_id INTEGER NOT NULL,
  key TEXT NOT NULL,                   -- 'watchlist' | 'portfolio' | 'alert_rules'
  value TEXT NOT NULL,                 -- JSON
  updated_at INTEGER,
  PRIMARY KEY (user_id, key),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- FINRA short interest (settles twice a month, published ~8 business days later).
CREATE TABLE IF NOT EXISTS short_interest (
  symbol TEXT PRIMARY KEY, name TEXT, settlement_date TEXT,
  short_shares INTEGER, prev_short_shares INTEGER, avg_daily_volume INTEGER,
  days_to_cover REAL, change_pct REAL, updated_at INTEGER
);

-- FINRA ATS ("dark pool") weekly volume, summed across every venue per symbol.
CREATE TABLE IF NOT EXISTS dark_pool (
  symbol TEXT PRIMARY KEY, name TEXT, week_start TEXT,
  shares INTEGER, trades INTEGER, notional REAL, venues INTEGER, updated_at INTEGER
);

-- The one forward-looking table: which companies report, and when.
CREATE TABLE IF NOT EXISTS earnings_calendar (
  symbol TEXT NOT NULL, date TEXT NOT NULL, company TEXT,
  session TEXT, eps_forecast TEXT, last_eps TEXT, updated_at INTEGER,
  PRIMARY KEY (symbol, date)
);
CREATE INDEX IF NOT EXISTS idx_earn_date ON earnings_calendar(date);

CREATE TABLE IF NOT EXISTS legislator_committees (
  bioguide TEXT PRIMARY KEY, committees TEXT
);

CREATE TABLE IF NOT EXISTS legislators (
  bioguide TEXT PRIMARY KEY, name_full TEXT, first TEXT, last TEXT,
  party TEXT, state TEXT, chamber TEXT, match_key TEXT
);
CREATE INDEX IF NOT EXISTS idx_leg_match ON legislators(match_key);

CREATE TABLE IF NOT EXISTS job_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job TEXT, status TEXT, detail TEXT,
  started_at INTEGER, finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_jobs ON job_runs(job, started_at DESC);

-- Stock Battles: shareable pick-vs-pick paper contests scored on real prices.
-- picks_* and start_prices are JSON; start_prices snapshots the real close when
-- the battle activates (both sides locked). Purely virtual — no real trades.
CREATE TABLE IF NOT EXISTS battles (
  id TEXT PRIMARY KEY,
  player_a TEXT, player_b TEXT,
  picks_a TEXT, picks_b TEXT,
  start_prices TEXT,
  start_at INTEGER, end_at INTEGER,
  status TEXT DEFAULT 'pending',
  winner TEXT,
  created_at INTEGER
);
`);

// additive migrations for existing databases
for (const [table, col, type] of [
  ['politician_trades', 'link', 'TEXT'],
  ['politician_trades', 'bioguide', 'TEXT'],
  ['news', 'ai_why', 'TEXT'],
  ['price_history', 'open', 'REAL'],
  ['price_history', 'high', 'REAL'],
  ['price_history', 'low', 'REAL'],
  ['funds', 'ticker', 'TEXT'],
  ['funds', 'country', 'TEXT'],
  ['news', 'image', 'TEXT'],
  ['tickers', 'sector', 'TEXT'],
  ['tickers', 'industry', 'TEXT'],
  // Battle Room lobby: host settings + per-player ready state and trash talk
  ['battles', 'settings', 'TEXT'],
  ['battles', 'ready_a', 'INTEGER DEFAULT 0'],
  ['battles', 'ready_b', 'INTEGER DEFAULT 0'],
  ['battles', 'trash_a', 'TEXT'],
  ['battles', 'trash_b', 'TEXT'],
  // AI news triage: how much this story actually matters, and what it is about
  ['news', 'importance', 'TEXT'],      // High | Medium | Low
  ['news', 'impact_score', 'INTEGER'], // 0-100, drives "important only" filtering
  ['news', 'topic', 'TEXT'],           // Earnings | M&A | Fed & Economy | …
]) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
}

export const kv = {
  get(key) {
    const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
    return row ? JSON.parse(row.value) : null;
  },
  set(key, value) {
    db.prepare(
      'INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
    ).run(key, JSON.stringify(value), Date.now());
  },
};

export function recordJob(job, status, detail, startedAt) {
  db.prepare(
    'INSERT INTO job_runs (job, status, detail, started_at, finished_at) VALUES (?, ?, ?, ?, ?)'
  ).run(job, status, detail ?? null, startedAt, Date.now());
  // keep the log bounded
  db.prepare(
    "DELETE FROM job_runs WHERE id NOT IN (SELECT id FROM job_runs ORDER BY id DESC LIMIT 2000)"
  ).run();
}
