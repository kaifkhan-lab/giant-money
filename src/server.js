import express from 'express';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, kv } from './db.js';
import { refreshQuote, getQuote, fundamentals, tickerInfo, refreshQuotesViaCNBC, ensureOHLCHistory, historyRange, closeOnOrAfter } from './sources/quotes.js';
import { photoUrl, committeesFor } from './sources/congress.js';
import { amountMidpoint } from './analysis/score.js';
import { cachedShadow, fundWeightsFor, SHADOW_BASE } from './analysis/shadow.js';
import { personFor } from './sources/people.js';
import { FUNDS } from './sources/funds.js';
import { aiEngineStatus } from './analysis/ai.js';
import { logErr } from './util.js';
import {
  validateCredentials, createUser, authenticate, emailTaken,
  createSession, destroySession, currentUser, readCookie,
  setSessionCookie, clearSessionCookie,
  tooManyAttempts, noteFailedAttempt, clearAttempts,
  getUserData, setUserData,
} from './auth.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export function createServer() {
  const app = express();
  app.use(express.json({ limit: '64kb' }));
  // Liveness probe for hosting platforms — cheap, no database work.
  app.get('/healthz', (req, res) => res.type('text').send('ok'));

  // ── API rate limit ────────────────────────────────────────────────────────
  // This matters more than a normal app's rate limit. Several endpoints fetch
  // from SEC EDGAR, Nasdaq and CNBC on a cache miss, so an unthrottled caller
  // does not just load *this* server — it makes those upstreams see a flood from
  // our IP and block it, which breaks the platform for everybody. The window is
  // generous for a human clicking around and tight enough to stop a script.
  const RL_WINDOW = 60e3;
  const RL_MAX = 120;             // requests per IP per minute
  const RL_MAX_HEAVY = 25;        // for routes that can trigger an upstream fetch
  // Inside app.use('/api', …) the mount point is stripped from req.path, so this
  // matches "/stock/AAPL", not "/api/stock/AAPL". Getting that wrong silently
  // disables the heavy limit, which is the one that actually protects upstreams.
  const HEAVY = /^\/(stock|history|index|gov|shadow|search)\b/;
  const hits = new Map();

  setInterval(() => {
    const cutoff = Date.now() - RL_WINDOW;
    for (const [ip, rec] of hits) if (rec.start < cutoff) hits.delete(ip);
  }, RL_WINDOW).unref();

  app.use('/api', (req, res, next) => {
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
      || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    let rec = hits.get(ip);
    if (!rec || now - rec.start > RL_WINDOW) { rec = { start: now, n: 0, heavy: 0 }; hits.set(ip, rec); }
    rec.n++;
    const heavy = HEAVY.test(req.path);
    if (heavy) rec.heavy++;

    if (rec.n > RL_MAX || (heavy && rec.heavy > RL_MAX_HEAVY)) {
      res.set('Retry-After', String(Math.ceil((RL_WINDOW - (now - rec.start)) / 1000)));
      return res.status(429).json({ error: 'Too many requests — slow down for a moment.' });
    }
    next();
  });

  // ── Accounts ──────────────────────────────────────────────────────────────
  // Signing in is optional: all market data stays public. An account exists so
  // a person's own watchlist, portfolio and alerts follow them between devices
  // instead of living only in one browser's localStorage.
  const clientIp = req =>
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';

  // These two need the response object directly, to attach the session cookie.
  app.post('/api/auth/signup', (req, res) => {
    try {
      const v = validateCredentials(req.body?.email, req.body?.password);
      if (v.error) return res.status(400).json({ ok: false, error: v.error });
      if (emailTaken(v.email)) {
        return res.status(409).json({ ok: false, error: 'An account with that email already exists.' });
      }
      const user = createUser({ ...v, name: req.body?.name });
      setSessionCookie(res, createSession(user.id), req);
      res.json({ ok: true, user });
    } catch (err) {
      logErr('api', 'signup', String(err));
      res.status(500).json({ ok: false, error: 'Could not create the account.' });
    }
  });

  app.post('/api/auth/login', (req, res) => {
    const ip = clientIp(req);
    try {
      if (tooManyAttempts(ip)) {
        return res.status(429).json({ ok: false, error: 'Too many attempts. Wait a few minutes and try again.' });
      }
      const v = validateCredentials(req.body?.email, req.body?.password);
      // Deliberately vague in both branches: never confirm whether an email is
      // registered, and never say which half of the pair was wrong.
      const user = v.error ? null : authenticate(v.email, v.password);
      if (!user) {
        noteFailedAttempt(ip);
        return res.status(401).json({ ok: false, error: 'Email or password is incorrect.' });
      }
      clearAttempts(ip);
      setSessionCookie(res, createSession(user.id), req);
      res.json({ ok: true, user });
    } catch (err) {
      logErr('api', 'login', String(err));
      res.status(500).json({ ok: false, error: 'Could not sign in.' });
    }
  });

  app.post('/api/auth/logout', (req, res) => {
    destroySession(readCookie(req));
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  app.get('/api/auth/me', (req, res) => {
    const user = currentUser(req);
    res.json({ user: user ?? null });
  });

  // Per-account storage for the lists that used to live only in localStorage.
  app.get('/api/me/data', (req, res) => {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ error: 'Not signed in' });
    res.json({
      watchlist: getUserData(user.id, 'watchlist') ?? [],
      portfolio: getUserData(user.id, 'portfolio') ?? [],
      alert_rules: getUserData(user.id, 'alert_rules') ?? [],
    });
  });

  app.post('/api/me/data', (req, res) => {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ error: 'Not signed in' });
    const allowed = ['watchlist', 'portfolio', 'alert_rules'];
    for (const key of allowed) {
      if (req.body && Object.hasOwn(req.body, key)) setUserData(user.id, key, req.body[key]);
    }
    res.json({ ok: true });
  });
  // Front page is now the "200-Year Edge" story landing. The previous marketing
  // landing is preserved at /classic. Registered before express.static so this
  // wins over static's default index.html for "/".
  app.get('/', (req, res) => res.sendFile(join(root, 'public', 'edge.html')));
  app.get('/classic', (req, res) => res.sendFile(join(root, 'public', 'index.html')));
  app.use(express.static(join(root, 'public')));
  app.get('/app', (req, res) => res.sendFile(join(root, 'public', 'app.html')));
  app.get('/login', (req, res) => res.sendFile(join(root, 'public', 'login.html')));
  // "/edge" kept as an alias for any existing links to the story landing
  app.get('/edge', (req, res) => res.sendFile(join(root, 'public', 'edge.html')));
  // one single dashboard — old /dashboard link now opens the full app
  app.get('/dashboard', (req, res) => res.redirect(302, '/app#dashboard'));

  // profile image for a tracked filer: investment banks use their real company
  // logo (not a building photo); people use their Wikipedia portrait.
  const BANK_LOGO = {};
  for (const f of FUNDS) {
    if (f.category === 'investment_bank' && f.ticker) {
      BANK_LOGO[f.cik] = `https://images.financialmodelingprep.com/symbol/${f.ticker}.png`;
    }
  }
  const fundPhoto = (cik, category) =>
    (category === 'investment_bank' && BANK_LOGO[cik]) || personFor(cik)?.photo || null;

  const wrap = fn => async (req, res) => {
    try {
      res.json(await fn(req));
    } catch (err) {
      logErr('api', req.path, String(err));
      res.status(500).json({ error: String(err.message ?? err) });
    }
  };

  const parseTickers = row => ({ ...row, tickers: safeJSON(row.tickers, []) });
  const safeJSON = (s, d) => { try { return JSON.parse(s) ?? d; } catch { return d; } };
  const enrichTrade = t => {
    const q = t.ticker ? getQuote(t.ticker) : null;
    const current = q?.price ?? null;
    const gain = t.price && current ? ((current - t.price) / t.price) * 100 : null;
    return { ...t, current_price: current, gain_pct: gain };
  };

  // ── Market indexes ────────────────────────────────────────────────────────
  app.get('/api/overview', wrap(() => ({
    indexes: db.prepare('SELECT * FROM market_indexes ORDER BY rowid').all(),
    bootstrapDone: kv.get('bootstrap_done'),
  })));

  // ── Smart money flow ─────────────────────────────────────────────────────
  // ── Institutional stock picks (one box, 1d / 1w / 1m windows) ─────────────
  // tickers with real smart-money activity in the window (insider filings,
  // 13F changes, news mentions), ranked by the Giant Money Score
  app.get('/api/smart-picks', wrap(req => {
    const range = ['1d', '1w', '1m'].includes(req.query.range) ? req.query.range : '1d';
    const days = { '1d': 1, '1w': 7, '1m': 30 }[range];
    const sinceMs = Date.now() - days * 864e5;
    const sinceDate = ago(days);
    const picks = db.prepare(`
      SELECT s.* FROM scores s WHERE s.ticker IN (
        SELECT DISTINCT ticker FROM insider_trades WHERE filed_at >= ? AND ticker IS NOT NULL
        UNION SELECT j.value FROM news, json_each(news.tickers) j WHERE news.published_at >= ?
        UNION SELECT DISTINCT ticker FROM fund_changes WHERE filed_at >= ? AND ticker IS NOT NULL
      ) ORDER BY s.score DESC LIMIT 12`)
      .all(sinceMs, sinceMs, sinceDate)
      .map(r => ({ ...r, components: safeJSON(r.components, {}) }));

    // A rank and a number mean nothing on their own. Attach the actual people
    // and firms behind each pick so the card can say WHY it is on the list.
    const insidersOf = db.prepare(`
      SELECT insider_name who, insider_title role, side,
             SUM(COALESCE(value, shares*COALESCE(price,0))) amt, COUNT(*) n
      FROM insider_trades
      WHERE ticker = ? AND filed_at >= ? AND side = 'Buy'
      GROUP BY insider_name ORDER BY amt DESC LIMIT 3`);
    const fundsOf = db.prepare(`
      SELECT f.name fund, f.manager, fc.change_type, (fc.new_value - fc.old_value) dv
      FROM fund_changes fc JOIN funds f ON f.cik = fc.cik
      WHERE fc.ticker = ? AND fc.filed_at >= ?
      ORDER BY ABS(fc.new_value - fc.old_value) DESC LIMIT 3`);
    const polsOf = db.prepare(`
      SELECT name who, side, amount, trade_date
      FROM politician_trades
      WHERE ticker = ? AND trade_date >= ? AND side IN ('Buy','Sell')
      ORDER BY trade_date DESC LIMIT 3`);
    const quoteOf = db.prepare('SELECT price, change_pct, name FROM quotes WHERE symbol = ?');

    const enriched = picks.map(p => {
      const insiders = insidersOf.all(p.ticker, sinceMs);
      const funds = fundsOf.all(p.ticker, sinceDate);
      const pols = polsOf.all(p.ticker, sinceDate);
      const q = quoteOf.get(p.ticker) ?? {};

      // one plain-English line explaining the strongest reason it ranks here
      const reasons = [];
      if (funds.length) {
        const f = funds[0];
        const verb = { new: 'opened a position in', increased: 'added to', reduced: 'trimmed', closed: 'exited' }[f.change_type] ?? 'moved on';
        reasons.push({ kind: 'fund', text: `${f.manager && f.manager !== '—' ? f.manager : f.fund} ${verb} it`, amount: f.dv });
      }
      if (insiders.length) {
        const i = insiders[0];
        reasons.push({ kind: 'insider', text: `${i.who}${i.role ? ` (${i.role})` : ''} bought shares`, amount: i.amt });
      }
      if (pols.length) {
        const t = pols[0];
        reasons.push({ kind: 'politician', text: `${t.who} ${String(t.side).toLowerCase()} it`, amount: null, note: t.amount });
      }
      return {
        ...p,
        price: q.price ?? null, change_pct: q.change_pct ?? null, company: q.name ?? p.name,
        insiders, funds, pols, reasons,
        buyerCount: insiders.length + funds.length + pols.length,
      };
    });
    return { range, picks: enriched };
  }));

  // ── "Who Bought Before the News?" — detective view, cached 15 min ─────────
  // today's biggest movers, matched against real buys in the prior 14 days
  app.get('/api/detective', wrap(() => {
    const cached = kv.get('detective');
    if (cached && Date.now() - cached.at < 15 * 60e3) return cached.data;
    const movers = db.prepare(`
      SELECT symbol ticker, name, price, change_pct FROM quotes
      WHERE change_pct IS NOT NULL AND ABS(change_pct) >= 4 AND price >= 1
      ORDER BY ABS(change_pct) DESC LIMIT 12`).all();
    const since = ago(14);
    const cases = [];
    for (const m of movers) {
      if (cases.length >= 6) break;
      const insiders = db.prepare(`
        SELECT insider_name, insider_title, value, shares, price, trade_date FROM insider_trades
        WHERE ticker = ? AND side = 'Buy' AND trade_date >= ?
        ORDER BY COALESCE(value, 0) DESC LIMIT 5`).all(m.ticker, since);
      const funds = db.prepare(`
        SELECT f.name fund_name, f.manager, fc.change_type, fc.new_value - fc.old_value delta, fc.filed_at
        FROM fund_changes fc JOIN funds f ON f.cik = fc.cik
        WHERE fc.ticker = ? AND fc.change_type IN ('new','increased') AND fc.filed_at >= ?
        ORDER BY delta DESC LIMIT 4`).all(m.ticker, since);
      const pols = db.prepare(`
        SELECT name, bioguide, amount, trade_date FROM politician_trades
        WHERE ticker = ? AND side = 'Buy' AND disclosure_date >= ? LIMIT 4`).all(m.ticker, since)
        .map(p => ({ ...p, photo: photoUrl(p.bioguide) }));
      const news = db.prepare(`
        SELECT title, source, published_at FROM news, json_each(news.tickers) j
        WHERE j.value = ? ORDER BY published_at DESC LIMIT 1`).get(m.ticker);
      if (insiders.length || funds.length || pols.length) {
        cases.push({ ...m, insiders, funds, pols, news: news ?? null });
      }
    }
    const data = { cases, checkedMovers: movers.length, windowDays: 14 };
    kv.set('detective', { at: Date.now(), data });
    return data;
  }));

  // ── Insider trading (dashboard section) ──────────────────────────────────
  app.get('/api/insiders', wrap(() => {
    const d1 = ago(1), d7 = ago(7);
    const base = `SELECT * FROM insider_trades WHERE ticker IS NOT NULL`;
    const latestBuys = db.prepare(`${base} AND side='Buy' ORDER BY filed_at DESC LIMIT 40`).all().map(enrichTrade);
    const latestSells = db.prepare(`${base} AND side='Sell' ORDER BY filed_at DESC LIMIT 40`).all().map(enrichTrade);
    const roleBuys = role => db.prepare(
      `${base} AND side='Buy' AND insider_title LIKE ? ORDER BY filed_at DESC LIMIT 15`
    ).all(role).map(enrichTrade);
    const large = db.prepare(
      `${base} AND value >= 1000000 ORDER BY filed_at DESC LIMIT 25`
    ).all().map(enrichTrade);
    const mostActive = db.prepare(`
      SELECT ticker, company, COUNT(*) n, SUM(CASE WHEN side='Buy' THEN 1 ELSE 0 END) buys,
             SUM(CASE WHEN side='Sell' THEN 1 ELSE 0 END) sells
      FROM insider_trades WHERE ticker IS NOT NULL AND trade_date >= ?
      GROUP BY ticker ORDER BY n DESC LIMIT 10`).all(d7);
    const rank = (side, since) => db.prepare(`
      SELECT ticker, company, SUM(COALESCE(value, shares*COALESCE(price,0))) total, COUNT(*) n
      FROM insider_trades WHERE side=? AND ticker IS NOT NULL AND trade_date >= ?
      GROUP BY ticker ORDER BY total DESC LIMIT 10`).all(side, since);
    const sentiment = db.prepare(`
      SELECT ticker, name, insider_sentiment, score FROM scores
      WHERE insider_sentiment IS NOT NULL ORDER BY score DESC LIMIT 20`).all();
    // 7-day buy/sell dollar totals for the summary tiles
    const totals = db.prepare(`
      SELECT side, SUM(COALESCE(value, shares*COALESCE(price,0))) total, COUNT(*) n
      FROM insider_trades WHERE trade_date >= ? GROUP BY side`).all(d7)
      .reduce((acc, r) => ({ ...acc, [r.side]: { total: r.total ?? 0, n: r.n } }), {});
    // cluster flags: 3+ distinct insiders in the same stock within 48h
    const clusters = db.prepare(`
      SELECT ticker, company, COUNT(DISTINCT insider_name) insiders,
             SUM(CASE WHEN side='Buy' THEN 1 ELSE 0 END) buys,
             SUM(CASE WHEN side='Sell' THEN 1 ELSE 0 END) sells
      FROM insider_trades WHERE ticker IS NOT NULL AND filed_at >= ?
      GROUP BY ticker HAVING insiders >= 3 ORDER BY insiders DESC LIMIT 12`)
      .all(Date.now() - 48 * 3600 * 1000);
    return {
      totals, clusters,
      latestBuys, latestSells,
      ceoBuys: roleBuys('%CEO%'), cfoBuys: roleBuys('%CFO%'), directorBuys: roleBuys('%Director%'),
      largeTransactions: large,
      mostActive,
      topBuyingToday: rank('Buy', d1), topBuyingWeek: rank('Buy', d7),
      topSellingToday: rank('Sell', d1), topSellingWeek: rank('Sell', d7),
      sentiment,
    };
  }));

  // ── Top 1% ────────────────────────────────────────────────────────────────
  app.get('/api/top1', wrap(() => {
    const funds = db.prepare(`
      SELECT f.*, ff.accession, ff.period, ff.filed_at, ff.total_value, ff.holdings_count
      FROM funds f LEFT JOIN fund_filings ff ON ff.id = (
        SELECT id FROM fund_filings WHERE cik = f.cik ORDER BY filed_at DESC LIMIT 1
      ) ORDER BY ff.total_value DESC NULLS LAST`).all()
      .map(f => {
        const latest = db.prepare(`
          SELECT * FROM fund_changes WHERE cik = ?
          ORDER BY filed_at DESC, ABS(new_value-old_value) DESC LIMIT 1`).get(f.cik);
        return { ...f, photo: fundPhoto(f.cik, f.category), latestMove: latest ?? null };
      });
    const changes = type => db.prepare(`
      SELECT fc.*, f.name fund_name, f.manager FROM fund_changes fc
      JOIN funds f ON f.cik = fc.cik
      WHERE change_type = ? ORDER BY ABS(new_value - old_value) DESC LIMIT 15`).all(type);
    const recentFilings = db.prepare(`
      SELECT ff.*, f.name fund_name, f.category FROM fund_filings ff
      JOIN funds f ON f.cik = ff.cik ORDER BY ff.filed_at DESC LIMIT 15`).all();
    return {
      funds,
      newPositions: changes('new'),
      closedPositions: changes('closed'),
      increasedPositions: changes('increased'),
      reducedPositions: changes('reduced'),
      recentFilings,
    };
  }));

  app.get('/api/top1/:cik', wrap(req => {
    const cik = req.params.cik.replace(/\D/g, '');
    const fund = db.prepare('SELECT * FROM funds WHERE cik = ?').get(cik);
    if (!fund) throw new Error('unknown fund');
    const filing = db.prepare(
      'SELECT * FROM fund_filings WHERE cik = ? ORDER BY filed_at DESC LIMIT 1').get(cik);
    const holdings = filing ? db.prepare(
      'SELECT * FROM fund_holdings WHERE filing_id = ? ORDER BY value DESC LIMIT 30').all(filing.id) : [];
    const changes = db.prepare(
      'SELECT * FROM fund_changes WHERE cik = ? ORDER BY ABS(new_value-old_value) DESC LIMIT 40').all(cik);
    // summary of buy/sell activity this cycle
    const summary = { new: 0, increased: 0, reduced: 0, closed: 0, bought: 0, sold: 0 };
    for (const a of db.prepare(
      'SELECT change_type, COUNT(*) n, SUM(new_value-old_value) dv FROM fund_changes WHERE cik = ? GROUP BY change_type'
    ).all(cik)) {
      summary[a.change_type] = a.n;
      if (a.change_type === 'new' || a.change_type === 'increased') summary.bought += a.dv || 0;
      else summary.sold += Math.abs(a.dv || 0);
    }
    const topBuy = db.prepare(`SELECT ticker, issuer, new_value-old_value dv FROM fund_changes
      WHERE cik = ? AND change_type IN ('new','increased') ORDER BY dv DESC LIMIT 1`).get(cik);
    const topSell = db.prepare(`SELECT ticker, issuer, old_value-new_value dv FROM fund_changes
      WHERE cik = ? AND change_type IN ('reduced','closed') ORDER BY dv DESC LIMIT 1`).get(cik);
    return {
      fund: { ...fund, photo: fundPhoto(cik, fund.category) },
      filing, holdings, changes, person: personFor(cik),
      summary, topBuy, topSell,
    };
  }));

  // ── Politicians ───────────────────────────────────────────────────────────
  const sectorOf = t => t ? db.prepare('SELECT sector, industry FROM tickers WHERE ticker = ?').get(t) : null;
  const decorateTrade = t => {
    const leg = t.bioguide
      ? db.prepare('SELECT party, state, chamber FROM legislators WHERE bioguide = ?').get(t.bioguide)
      : null;
    const lateDays =
      t.disclosure_date && t.trade_date && t.side !== 'Filing'
        ? Math.round((Date.parse(t.disclosure_date) - Date.parse(t.trade_date)) / 864e5) - 45
        : null; // STOCK Act allows 45 days
    const sec = sectorOf(t.ticker);
    return {
      ...t,
      current_price: t.ticker ? getQuote(t.ticker)?.price ?? null : null,
      party: leg?.party ?? null,
      state: leg?.state ?? null,
      photo: photoUrl(t.bioguide),
      filed_late_days: lateDays != null && lateDays > 0 ? lateDays : null,
      sector: sec?.sector ?? null,
      industry: sec?.industry ?? null,
      amount_mid: t.side === 'Buy' || t.side === 'Sell' ? amountMidpoint(t.amount) : null,
    };
  };

  // trade-level rows only (senate dataset + FMP); house rows are filing records
  const POL_TRADE_SQL = "SELECT * FROM politician_trades WHERE side IN ('Buy','Sell')";
  const polMaxDate = () =>
    db.prepare(`SELECT MAX(trade_date) d FROM politician_trades WHERE side IN ('Buy','Sell')`).get().d;
  const anchorAgo = (anchor, days) =>
    new Date(Date.parse(anchor) - days * 864e5).toISOString().slice(0, 10);

  // estimated net positions from disclosed ranges (midpoints) — clearly an estimate
  function estimatedPositions(rows) {
    const pos = new Map();
    for (const t of rows) {
      if (!t.ticker) continue;
      const mid = amountMidpoint(t.amount);
      const cur = pos.get(t.ticker) ?? 0;
      pos.set(t.ticker, cur + (t.side === 'Buy' ? mid : -mid));
    }
    return [...pos.entries()]
      .filter(([, v]) => v > 500)
      .map(([ticker, estValue]) => ({
        ticker,
        estValue,
        name: db.prepare('SELECT name FROM tickers WHERE ticker = ?').get(ticker)?.name ?? ticker,
        sector: sectorOf(ticker)?.sector ?? 'Other',
        quote: getQuote(ticker) ?? null,
      }))
      .sort((a, b) => b.estValue - a.estValue);
  }

  function polHeader(name) {
    const bio = db.prepare(
      'SELECT bioguide FROM politician_trades WHERE name = ? AND bioguide IS NOT NULL LIMIT 1'
    ).get(name)?.bioguide ?? null;
    const leg = bio ? db.prepare('SELECT party, state, chamber FROM legislators WHERE bioguide = ?').get(bio) : null;
    return { name, bioguide: bio, photo: photoUrl(bio), party: leg?.party ?? null, state: leg?.state ?? null, chamber: leg?.chamber ?? null };
  }

  app.get('/api/politicians', wrap(req => {
    const chamber = ['Senate', 'House'].includes(req.query.chamber) ? req.query.chamber : null;
    const q = req.query.q ? `%${req.query.q}%` : null;
    const side = ['Buy', 'Sell', 'Filing'].includes(req.query.side) ? req.query.side : null;
    let sql = 'SELECT * FROM politician_trades WHERE 1=1';
    const args = [];
    if (chamber) { sql += ' AND chamber = ?'; args.push(chamber); }
    if (side) { sql += ' AND side = ?'; args.push(side); }
    if (q) { sql += ' AND (name LIKE ? OR ticker LIKE ? OR asset LIKE ?)'; args.push(q, q, q); }
    sql += ' ORDER BY trade_date DESC LIMIT 250';
    const trades = db.prepare(sql).all(...args).map(decorateTrade);
    const counts = db.prepare(
      'SELECT chamber, COUNT(*) n FROM politician_trades GROUP BY chamber').all();
    return { trades, counts };
  }));

  app.get('/api/politician/:bioguide', wrap(req => {
    const bioguide = String(req.params.bioguide).replace(/[^A-Za-z0-9]/g, '');
    const member = db.prepare('SELECT * FROM legislators WHERE bioguide = ?').get(bioguide);
    if (!member) throw new Error('unknown member');
    const trades = db.prepare(
      'SELECT * FROM politician_trades WHERE bioguide = ? ORDER BY trade_date DESC LIMIT 300'
    ).all(bioguide).map(decorateTrade);

    // ── real, derived stats (senate trade-level rows; house rows are filings) ──
    const tr = trades.filter(t => t.side === 'Buy' || t.side === 'Sell');
    const buys = tr.filter(t => t.side === 'Buy');
    const sells = tr.filter(t => t.side === 'Sell');
    const priced = buys.filter(t => t.perf_pct != null);
    const winRate = priced.length ? (priced.filter(t => t.perf_pct > 0).length / priced.length) * 100 : null;
    const avgReturn = priced.length ? priced.reduce((s, t) => s + t.perf_pct, 0) / priced.length : null;
    const byPerf = [...priced].sort((a, b) => b.perf_pct - a.perf_pct);
    const positions = estimatedPositions(tr);
    const estPortfolioValue = positions.reduce((s, p) => s + p.estValue, 0);

    // sector allocation of the estimated positions
    const secMap = new Map();
    for (const p of positions) secMap.set(p.sector, (secMap.get(p.sector) ?? 0) + p.estValue);
    const sectorAllocation = [...secMap.entries()]
      .map(([sector, value]) => ({ sector, value, pct: estPortfolioValue ? (value / estPortfolioValue) * 100 : 0 }))
      .sort((a, b) => b.value - a.value).slice(0, 8);

    // monthly activity (last 24 months that actually contain trades)
    const monthly = db.prepare(`
      SELECT substr(trade_date, 1, 7) ym,
             SUM(CASE WHEN side='Buy' THEN 1 ELSE 0 END) buys,
             SUM(CASE WHEN side='Sell' THEN 1 ELSE 0 END) sells
      FROM politician_trades WHERE bioguide = ? AND side IN ('Buy','Sell')
      GROUP BY ym ORDER BY ym DESC LIMIT 24`).all(bioguide).reverse();

    // analytics scores (all derived; labeled in UI)
    const hhi = estPortfolioValue
      ? positions.reduce((s, p) => s + Math.pow(p.estValue / estPortfolioValue, 2), 0) : null;
    const anchor = tr.length ? tr[0].trade_date : null;
    const recentCut = anchor ? anchorAgo(anchor, 180) : null;
    const priorCut = anchor ? anchorAgo(anchor, 360) : null;
    const recentNet = recentCut ? tr.filter(t => t.trade_date >= recentCut)
      .reduce((s, t) => s + (t.side === 'Buy' ? 1 : -1) * (t.amount_mid ?? 0), 0) : null;
    const priorNet = recentCut ? tr.filter(t => t.trade_date >= priorCut && t.trade_date < recentCut)
      .reduce((s, t) => s + (t.side === 'Buy' ? 1 : -1) * (t.amount_mid ?? 0), 0) : null;
    const analytics = {
      diversification: hhi != null ? Math.round((1 - hhi) * 100) : null, // 0..100
      conviction: buys.length ? buys.reduce((s, t) => s + (t.amount_mid ?? 0), 0) / buys.length : null,
      activity12m: anchor ? tr.filter(t => t.trade_date >= anchorAgo(anchor, 365)).length : 0,
      momentum: recentNet != null && priorNet != null ? recentNet - priorNet : null,
      accuracy: winRate,
    };

    // plain-language profile, generated ONLY from the stats above
    const topSec = sectorAllocation[0]?.sector;
    const styleBrief = tr.length ? [
      `${member.name_full} has ${tr.length} disclosed stock trades on record (${buys.length} buys, ${sells.length} sells).`,
      topSec && topSec !== 'Other' ? `Their disclosed positions lean toward ${topSec}.` : null,
      analytics.conviction ? `Typical buy size is about ${Math.round(analytics.conviction / 1000)}K (midpoint of reported ranges).` : null,
      winRate != null ? `${Math.round(winRate)}% of their priced buys are up since the trade date.` : null,
    ].filter(Boolean).join(' ') : null;

    return {
      member: { ...member, photo: photoUrl(bioguide) },
      committees: committeesFor(bioguide),
      trades,
      stats: {
        totalTrades: tr.length, buys: buys.length, sells: sells.length,
        filings: trades.length - tr.length,
        winRate, avgReturn,
        bestTrade: byPerf[0] ? { ticker: byPerf[0].ticker, perf: byPerf[0].perf_pct, date: byPerf[0].trade_date } : null,
        worstTrade: byPerf.at(-1) && byPerf.length > 1 ? { ticker: byPerf.at(-1).ticker, perf: byPerf.at(-1).perf_pct, date: byPerf.at(-1).trade_date } : null,
        estPortfolioValue,
        firstTrade: tr.at(-1)?.trade_date ?? null,
        lastTrade: tr[0]?.trade_date ?? null,
      },
      positions: positions.slice(0, 12),
      sectorAllocation,
      monthly,
      analytics,
      styleBrief,
    };
  }));

  // ── Politician rankings (all computed from disclosed trades) ─────────────
  app.get('/api/pol-rankings', wrap(() => {
    const anchor = polMaxDate();
    if (!anchor) return {};
    const win180 = anchorAgo(anchor, 180);
    const rows = db.prepare(`${POL_TRADE_SQL}`).all();
    const byName = new Map();
    for (const t of rows) {
      if (!byName.has(t.name)) byName.set(t.name, []);
      byName.get(t.name).push(t);
    }
    const entries = [...byName.entries()].map(([name, list]) => {
      const buys = list.filter(t => t.side === 'Buy');
      const priced = buys.filter(t => t.perf_pct != null);
      const mids = list.map(t => amountMidpoint(t.amount));
      const buyMid = buys.reduce((s, t) => s + amountMidpoint(t.amount), 0);
      const recent = list.filter(t => t.trade_date >= win180);
      return {
        ...polHeader(name),
        trades: list.length,
        buys: buys.length,
        avgReturn: priced.length >= 5 ? priced.reduce((s, t) => s + t.perf_pct, 0) / priced.length : null,
        pricedBuys: priced.length,
        estProfit: priced.reduce((s, t) => s + amountMidpoint(t.amount) * (t.perf_pct / 100), 0),
        avgBuySize: buys.length ? buyMid / buys.length : 0,
        estPortfolio: estimatedPositions(list).reduce((s, p) => s + p.estValue, 0),
        recentBuys: recent.filter(t => t.side === 'Buy').reduce((s, t) => s + amountMidpoint(t.amount), 0),
        recentSells: recent.filter(t => t.side === 'Sell').reduce((s, t) => s + amountMidpoint(t.amount), 0),
      };
    });
    const desc = (key, minFn) => entries
      .filter(minFn ?? (() => true))
      .sort((a, b) => (b[key] ?? -Infinity) - (a[key] ?? -Infinity))
      .slice(0, 8);
    return {
      anchor,
      bestPerformers: desc('avgReturn', e => e.avgReturn != null),
      mostProfitable: desc('estProfit', e => e.pricedBuys >= 5),
      mostActive: desc('trades'),
      highestConviction: desc('avgBuySize', e => e.buys >= 5),
      largestPortfolios: desc('estPortfolio'),
      biggestRecentBuyers: desc('recentBuys', e => e.recentBuys > 0),
      biggestRecentSellers: desc('recentSells', e => e.recentSells > 0),
    };
  }));

  // ── Smart-money signals around politician trades ──────────────────────────
  app.get('/api/pol-signals', wrap(() => {
    const anchor = polMaxDate();
    if (!anchor) return { signals: [] };
    const win = anchorAgo(anchor, 120);
    const polRows = db.prepare(
      `${POL_TRADE_SQL} AND ticker IS NOT NULL AND trade_date >= ?`).all(win);
    const byTicker = new Map();
    for (const t of polRows) {
      if (!byTicker.has(t.ticker)) byTicker.set(t.ticker, []);
      byTicker.get(t.ticker).push(t);
    }
    const d90 = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);
    const insiderBuySet = new Set(db.prepare(
      `SELECT DISTINCT ticker FROM insider_trades WHERE side='Buy' AND trade_date >= ? AND ticker IS NOT NULL`).all(d90).map(r => r.ticker));
    const fundBuys = db.prepare(`
      SELECT fc.ticker, GROUP_CONCAT(DISTINCT f.category) cats, GROUP_CONCAT(DISTINCT f.name) names
      FROM fund_changes fc JOIN funds f ON f.cik = fc.cik
      WHERE fc.change_type IN ('new','increased') AND fc.ticker IS NOT NULL
      GROUP BY fc.ticker`).all();
    const fundMap = new Map(fundBuys.map(r => [r.ticker, r]));

    const signals = [];
    for (const [ticker, list] of byTicker) {
      const names = [...new Set(list.map(t => t.name))];
      const buyers = [...new Set(list.filter(t => t.side === 'Buy').map(t => t.name))];
      const sellers = [...new Set(list.filter(t => t.side === 'Sell').map(t => t.name))];
      const fund = fundMap.get(ticker);
      const insider = insiderBuySet.has(ticker);
      const cats = fund ? String(fund.cats).split(',') : [];
      const kinds = [];
      if (buyers.length >= 2) kinds.push('co-buy');
      if (sellers.length >= 2) kinds.push('co-sell');
      if (buyers.length && insider) kinds.push('pol+insider');
      if (buyers.length && cats.includes('billionaire')) kinds.push('pol+billionaire');
      if (buyers.length && cats.includes('hedge_fund')) kinds.push('pol+hedge-fund');
      if (list.length >= 3 && !kinds.length) kinds.push('unusual-activity');
      if (!kinds.length) continue;

      let score = 35 + buyers.length * 12 + (insider ? 12 : 0) + cats.length * 8 + Math.min(list.length * 3, 15);
      score = Math.min(96, Math.round(score));
      const confidence = Math.min(95, 40 + names.length * 10 + (insider ? 15 : 0) + cats.length * 10);
      const q = getQuote(ticker);
      const why = [
        buyers.length ? `${buyers.length} politician${buyers.length > 1 ? 's' : ''} bought` : null,
        sellers.length >= 2 ? `${sellers.length} politicians sold` : null,
        insider ? 'corporate insiders bought in the last 90 days' : null,
        cats.includes('billionaire') ? 'a tracked billionaire fund added last quarter' : null,
        cats.includes('hedge_fund') ? 'hedge funds added last quarter' : null,
      ].filter(Boolean).join('; ');
      signals.push({
        ticker,
        name: db.prepare('SELECT name FROM tickers WHERE ticker = ?').get(ticker)?.name ?? ticker,
        sector: sectorOf(ticker)?.sector ?? null,
        kinds, score, confidence,
        politicians: names.slice(0, 5).map(polHeader),
        funds: fund ? String(fund.names).split(',').slice(0, 3) : [],
        insider,
        price: q?.price ?? null, change_pct: q?.change_pct ?? null,
        why: `Signal: ${why}. Based only on official disclosures & filings in this window.`,
      });
    }
    signals.sort((a, b) => b.score - a.score);
    return { anchor, window: win, signals: signals.slice(0, 14) };
  }));

  // ── Model portfolios (estimated from disclosed trades; labeled) ───────────
  app.get('/api/pol-portfolios', wrap(() => {
    const build = (label, filterSql, args = []) => {
      const rows = db.prepare(`${POL_TRADE_SQL} ${filterSql}`).all(...args);
      const priced = rows.filter(t => t.side === 'Buy' && t.perf_pct != null);
      const positions = estimatedPositions(rows).slice(0, 10);
      const estValue = estimatedPositions(rows).reduce((s, p) => s + p.estValue, 0);
      return {
        label,
        traders: new Set(rows.map(r => r.name)).size,
        trades: rows.length,
        estValue,
        avgReturn: priced.length ? priced.reduce((s, t) => s + t.perf_pct, 0) / priced.length : null,
        positions,
      };
    };
    return {
      portfolios: [
        build('Congress Portfolio', ''),
        build('Senate Portfolio', "AND chamber = 'Senate'"),
        build('House Portfolio', "AND chamber = 'House'"),
      ],
    };
  }));

  // ── Shadow Portfolio — "if you'd copied them a year ago" backtest ─────────
  // weights come from real disclosures; prices are real. Paper/virtual only.
  // Congress data can be lagged, so weight by their all-time disclosed buys
  // (their favourite stocks) and backtest those over the last 12 months.
  const congressBuyWeights = filterSql => () => {
    const raw = db.prepare(
      `SELECT ticker, amount FROM politician_trades
       WHERE side = 'Buy' AND ticker IS NOT NULL ${filterSql}`).all();
    const agg = new Map();
    for (const r of raw) agg.set(r.ticker, (agg.get(r.ticker) ?? 0) + amountMidpoint(r.amount));
    return [...agg.entries()]
      .map(([ticker, weight]) => ({ ticker, weight, name: db.prepare('SELECT name FROM tickers WHERE ticker = ?').get(ticker)?.name ?? ticker }))
      .sort((a, b) => b.weight - a.weight).slice(0, 12);
  };

  app.get('/api/shadow/fund/:cik', wrap(async req => {
    const cik = String(req.params.cik).replace(/\D/g, '');
    const fund = db.prepare('SELECT name, manager, category FROM funds WHERE cik = ?').get(cik);
    if (!fund) throw new Error('unknown fund');
    const result = await cachedShadow(`fund:${cik}`, fundWeightsFor(cik));
    return { subject: fund.manager && fund.manager !== '—' ? fund.manager : fund.name, kind: fund.category, base: SHADOW_BASE, result };
  }));

  app.get('/api/shadow/congress/:group', wrap(async req => {
    const g = String(req.params.group).toLowerCase();
    const filter = g === 'senate' ? "AND chamber = 'Senate'" : g === 'house' ? "AND chamber = 'House'" : '';
    const label = g === 'senate' ? 'the Senate' : g === 'house' ? 'the House' : 'Congress';
    const result = await cachedShadow(`congress:${g}`, congressBuyWeights(filter));
    return { subject: label, kind: 'congress', base: SHADOW_BASE, result };
  }));

  app.get('/api/shadow/politician/:bioguide', wrap(async req => {
    const bio = String(req.params.bioguide).replace(/[^A-Za-z0-9]/g, '');
    const m = db.prepare('SELECT name_full FROM legislators WHERE bioguide = ?').get(bio);
    if (!m) throw new Error('unknown member');
    const weights = () => {
      const raw = db.prepare(
        `SELECT ticker, amount FROM politician_trades WHERE bioguide = ? AND side='Buy' AND ticker IS NOT NULL`
      ).all(bio);
      const agg = new Map();
      for (const r of raw) agg.set(r.ticker, (agg.get(r.ticker) ?? 0) + amountMidpoint(r.amount));
      return [...agg.entries()].map(([ticker, weight]) => ({ ticker, weight, name: db.prepare('SELECT name FROM tickers WHERE ticker = ?').get(ticker)?.name ?? ticker }))
        .sort((a, b) => b.weight - a.weight).slice(0, 12);
    };
    const result = await cachedShadow(`pol:${bio}`, weights);
    return { subject: m.name_full, kind: 'politician', base: SHADOW_BASE, result };
  }));

  // ── Battles — real % change per ticker since a start date ─────────────────
  // Scores friendly pick-vs-pick battles. Purely virtual: the "score" is each
  // side's average real price move since the battle started. No trades.
  app.get('/api/battle-perf', wrap(async req => {
    const since = String(req.query.since ?? '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new Error('bad since date');
    const tickers = [...new Set(String(req.query.tickers ?? '').toUpperCase().split(/[^A-Z.\-]+/).filter(Boolean))].slice(0, 12);
    const perf = {};
    for (const t of tickers) {
      const known = db.prepare('SELECT ticker, name FROM tickers WHERE ticker = ?').get(t);
      if (!known) { perf[t] = null; continue; } // not a real US listing — honest null
      try {
        let quote = getQuote(t);
        if (quote?.price == null || Date.now() - (quote.updated_at ?? 0) > 15 * 60e3) {
          quote = await refreshQuote(t).catch(() => quote); // also backfills daily history
        }
        // baseline = last real close on/before the start date (battle-start price),
        // falling back to the first close after it (fresh listings)
        let start = db.prepare(
          'SELECT close FROM price_history WHERE symbol = ? AND date <= ? ORDER BY date DESC LIMIT 1'
        ).get(t, since)?.close;
        if (start == null) {
          await ensureOHLCHistory(t);
          start = db.prepare(
            'SELECT close FROM price_history WHERE symbol = ? AND date <= ? ORDER BY date DESC LIMIT 1'
          ).get(t, since)?.close ?? closeOnOrAfter(t, since);
        }
        const now = quote?.price ?? null;
        perf[t] = start != null && now != null
          ? { start, now, pct: +(((now - start) / start) * 100).toFixed(2), name: known.name }
          : null;
      } catch { perf[t] = null; }
    }
    return { since, perf };
  }));

  // ── Battles — shareable multiplayer paper contests (real prices) ──────────
  const round2 = v => (v == null || !isFinite(v) ? null : +Number(v).toFixed(2));
  const nameOfTicker = t => db.prepare('SELECT name FROM tickers WHERE ticker = ?').get(t)?.name ?? t;

  // a real smart-money signal line for a stock, or null (never invented)
  const stockSignal = ticker => {
    const t = String(ticker).toUpperCase();
    const ins = db.prepare(
      "SELECT COUNT(DISTINCT insider_name) n FROM insider_trades WHERE ticker=? AND side='Buy' AND trade_date >= ?"
    ).get(t, ago(7))?.n ?? 0;
    if (ins >= 1) return `🔥 ${ins} insider${ins > 1 ? 's' : ''} bought this week`;
    const fund = db.prepare(
      "SELECT COUNT(DISTINCT cik) n FROM fund_changes WHERE ticker=? AND change_type IN ('new','increased') AND filed_at >= ?"
    ).get(t, Date.now() - 100 * 864e5)?.n ?? 0;
    if (fund >= 1) return `🏛 ${fund} fund${fund > 1 ? 's' : ''} added recently`;
    const pol = db.prepare(
      "SELECT COUNT(*) n FROM politician_trades WHERE ticker=? AND side='Buy' AND disclosure_date >= ?"
    ).get(t, ago(45))?.n ?? 0;
    if (pol >= 1) return `🏛 ${pol} politician buy${pol > 1 ? 's' : ''} recently`;
    const sc = db.prepare('SELECT score FROM scores WHERE ticker=?').get(t)?.score;
    if (sc != null && sc >= 60) return `📈 Giant Money Score ${sc}`;
    return null;
  };

  // stock picker feed: trending by default, or search — each with its signal
  app.get('/api/pick-stocks', wrap(req => {
    const q = String(req.query.q ?? '').trim();
    const rows = q
      ? db.prepare('SELECT ticker, name FROM tickers WHERE ticker LIKE ? OR name LIKE ? LIMIT 30')
          .all(`${q.toUpperCase()}%`, `%${q}%`)
      : db.prepare('SELECT ticker, name FROM scores ORDER BY score DESC LIMIT 30').all();
    const stocks = rows.map(r => {
      const qq = getQuote(r.ticker);
      return { ticker: r.ticker, name: r.name ?? nameOfTicker(r.ticker), price: qq?.price ?? null, change_pct: qq?.change_pct ?? null, signal: stockSignal(r.ticker) };
    });
    return { stocks };
  }));

  // Room code: GM- + 6 unambiguous chars (no 0/O/1/I/L). The code IS the id.
  const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  const newBattleId = () => {
    for (let tries = 0; tries < 20; tries++) {
      let c = 'GM-';
      for (let i = 0; i < 6; i++) c += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
      if (!db.prepare('SELECT 1 FROM battles WHERE id=?').get(c)) return c;
    }
    return 'GM-' + Date.now().toString(36).toUpperCase().slice(-6);
  };
  const DURATION_DAYS = { 1: 1, 3: 3, 7: 7 };
  const parseSettings = s => {
    const o = s && typeof s === 'object' ? s : {};
    const dur = DURATION_DAYS[Number(o.duration)] ? Number(o.duration) : 7;
    const capital = [10000, 50000, 100000].includes(Number(o.capital)) ? Number(o.capital) : 100000;
    const market = ['us', 'crypto', 'both'].includes(o.market) ? o.market : 'us';
    const maxPlayers = Number(o.maxPlayers) === 5 ? 5 : 2;
    const maxPicks = Math.min(10, Math.max(3, Number(o.maxPicks) || 5));
    return { duration: dur, capital, market, maxPlayers, maxPicks };
  };
  const validPicks = (arr, max = 5) => {
    const out = [];
    for (const raw of (Array.isArray(arr) ? arr : [])) {
      const t = String(raw).toUpperCase().trim();
      if (out.length >= max || out.includes(t)) continue;
      if (db.prepare('SELECT 1 FROM tickers WHERE ticker=?').get(t)) out.push(t);
    }
    return out;
  };
  const ROOM_TTL = 24 * 3600 * 1000;
  const roomExpired = row => row.status === 'waiting' && Date.now() - (row.created_at ?? 0) > ROOM_TTL;
  const resolveRoom = row => {
    const settings = parseSettings(safeJSON(row.settings, {}));
    const player = (role, name, ready, trash, picksJson) => name == null ? null : {
      role, name, ready: !!ready, trash: trash || null,
      picks: safeJSON(picksJson, []).length, hasPicked: safeJSON(picksJson, []).length > 0,
    };
    const players = [
      player('a', row.player_a, row.ready_a, row.trash_a, row.picks_a),
      player('b', row.player_b, row.ready_b, row.trash_b, row.picks_b),
    ].filter(Boolean);
    return {
      code: row.id, status: roomExpired(row) ? 'expired' : row.status, winner: row.winner,
      settings, players,
      startAt: row.start_at, endAt: row.end_at,
      createdAt: row.created_at, expiresAt: (row.created_at ?? 0) + ROOM_TTL,
    };
  };
  const livePrice = async t => {
    let q = getQuote(t);
    if (q?.price == null || Date.now() - (q.updated_at ?? 0) > 15 * 60e3) q = await refreshQuote(t).catch(() => q);
    return q?.price ?? null;
  };
  const getRoom = code => db.prepare('SELECT * FROM battles WHERE id=?').get(String(code));

  // create room — host settings only; picks happen at ready-up in the lobby
  app.post('/api/battles', wrap(req => {
    const player = String(req.body?.player ?? '').trim().slice(0, 24) || 'Player';
    const settings = parseSettings(req.body?.settings);
    const id = newBattleId();
    db.prepare('INSERT INTO battles (id, player_a, ready_a, settings, status, created_at) VALUES (?,?,0,?,?,?)')
      .run(id, player, JSON.stringify(settings), 'waiting', Date.now());
    return { code: id, settings };
  }));

  app.get('/api/battles/:id', wrap(req => {
    const row = getRoom(req.params.id);
    if (!row) throw new Error('Room not found');
    return resolveRoom(row);
  }));

  // join a waiting room (name only). Guards: not found / started / full / expired
  app.post('/api/battles/:id/join', wrap(req => {
    const row = getRoom(req.params.id);
    if (!row) throw new Error('Room not found');
    if (roomExpired(row)) throw new Error('This battle expired');
    if (row.status !== 'waiting') throw new Error('This battle has already started');
    const player = String(req.body?.player ?? '').trim().slice(0, 24) || 'Challenger';
    if (row.player_b && row.player_b !== player) throw new Error('Room is full');
    db.prepare("UPDATE battles SET player_b=?, ready_b=0 WHERE id=?").run(player, row.id);
    return resolveRoom(getRoom(row.id));
  }));

  // ready up = lock in your picks (within the room's maxPicks)
  app.post('/api/battles/:id/pick', wrap(req => {
    const row = getRoom(req.params.id);
    if (!row) throw new Error('Room not found');
    if (row.status !== 'waiting') throw new Error('This battle has already started');
    const role = req.body?.role === 'b' ? 'b' : 'a';
    const settings = parseSettings(safeJSON(row.settings, {}));
    const picks = validPicks(req.body?.picks, settings.maxPicks);
    if (picks.length < 1) throw new Error('pick at least one valid stock');
    if (role === 'a') db.prepare("UPDATE battles SET picks_a=?, ready_a=1 WHERE id=?").run(JSON.stringify(picks), row.id);
    else db.prepare("UPDATE battles SET picks_b=?, ready_b=1 WHERE id=?").run(JSON.stringify(picks), row.id);
    return resolveRoom(getRoom(row.id));
  }));

  app.post('/api/battles/:id/trash', wrap(req => {
    const row = getRoom(req.params.id);
    if (!row) throw new Error('Room not found');
    const role = req.body?.role === 'b' ? 'b' : 'a';
    const text = String(req.body?.text ?? '').slice(0, 80);
    db.prepare(`UPDATE battles SET ${role === 'a' ? 'trash_a' : 'trash_b'}=? WHERE id=?`).run(text, row.id);
    return resolveRoom(getRoom(row.id));
  }));

  // host starts — both sides must be ready. Snapshots real start prices now.
  app.post('/api/battles/:id/start', wrap(async req => {
    const row = getRoom(req.params.id);
    if (!row) throw new Error('Room not found');
    if (roomExpired(row)) throw new Error('This battle expired');
    if (row.status === 'live' || row.status === 'finished') return { code: row.id, status: row.status };
    if (!row.player_b) throw new Error('Waiting for an opponent to join');
    if (!row.ready_a || !row.ready_b) throw new Error('Both players must be ready');
    const settings = parseSettings(safeJSON(row.settings, {}));
    const picksA = safeJSON(row.picks_a, []), picksB = safeJSON(row.picks_b, []);
    const startPrices = {};
    for (const t of [...new Set([...picksA, ...picksB])]) {
      const p = await livePrice(t);
      if (p != null) { startPrices[t] = p; ensureOHLCHistory(t).catch(() => {}); }
    }
    const startAt = Date.now(), endAt = startAt + settings.duration * 864e5;
    db.prepare("UPDATE battles SET start_prices=?, start_at=?, end_at=?, status='live' WHERE id=?")
      .run(JSON.stringify(startPrices), startAt, endAt, row.id);
    kv.set(`battlescore:${row.id}`, null);
    return { code: row.id, status: 'live', startAt, endAt };
  }));

  app.get('/api/battles/:id/scores', wrap(async req => {
    const id = String(req.params.id);
    const cached = kv.get(`battlescore:${id}`);
    if (cached && cached.data && Date.now() - cached.at < 60e3) return cached.data;
    const row = getRoom(id);
    if (!row) throw new Error('Room not found');
    const settings = parseSettings(safeJSON(row.settings, {}));
    const picksA = safeJSON(row.picks_a, []);
    const picksB = safeJSON(row.picks_b, []);
    const startPrices = safeJSON(row.start_prices, {});
    const all = [...new Set([...picksA, ...picksB])];

    const now = {};
    for (const t of all) now[t] = await livePrice(t);
    const pickPct = t => {
      const s = startPrices[t], n = now[t];
      return (s != null && n != null) ? round2(((n - s) / s) * 100) : null;
    };
    const sidePct = picks => {
      const v = picks.map(pickPct).filter(x => x != null);
      return v.length ? round2(v.reduce((s, x) => s + x, 0) / v.length) : null;
    };
    const detail = picks => picks.map(t => ({ ticker: t, name: nameOfTicker(t), pct: pickPct(t) }));
    const aPct = sidePct(picksA), bPct = sidePct(picksB);
    const cap = settings.capital;
    const val = p => (p == null ? null : round2(cap * (1 + p / 100)));

    let curve = [];
    if ((row.status === 'live' || row.status === 'finished') && row.start_at) {
      const startDate = new Date(row.start_at).toISOString().slice(0, 10);
      const series = {};
      for (const t of all) {
        try {
          const h = await historyRange(t, '1w');
          if (h?.length) { const m = new Map(); for (const r of h) if (r.close != null) m.set(String(r.date).slice(0, 10), r.close); series[t] = m; }
        } catch { /* skip ticker in curve */ }
      }
      const dates = new Set();
      for (const t of all) if (series[t]) for (const d of series[t].keys()) if (d > startDate) dates.add(d);
      const idxAt = (picks, d) => {
        const v = picks.map(t => {
          const s = startPrices[t], c = series[t]?.get(d);
          return (s != null && c != null) ? c / s : null;
        }).filter(x => x != null);
        return v.length ? round2((v.reduce((s, x) => s + x, 0) / v.length - 1) * 100) : null;
      };
      curve = [{ date: startDate, a: 0, b: 0 },
        ...[...dates].sort().map(d => ({ date: d, a: idxAt(picksA, d), b: idxAt(picksB, d) }))];
    }

    let status = row.status, winner = row.winner;
    if (status === 'live' && row.end_at && Date.now() >= row.end_at) {
      winner = (aPct == null && bPct == null) ? 'draw' : (aPct ?? -1e9) > (bPct ?? -1e9) ? 'a' : (bPct ?? -1e9) > (aPct ?? -1e9) ? 'b' : 'draw';
      status = 'finished';
      db.prepare("UPDATE battles SET status='finished', winner=? WHERE id=?").run(winner, id);
    }

    const data = {
      id: row.id, code: row.id, status, settings,
      players: {
        a: { name: row.player_a, pct: aPct, value: val(aPct), picks: detail(picksA), trash: row.trash_a || null },
        b: { name: row.player_b, pct: bPct, value: val(bPct), picks: detail(picksB), trash: row.trash_b || null },
      },
      leader: (aPct == null && bPct == null) ? null : (aPct ?? -1e9) >= (bPct ?? -1e9) ? 'a' : 'b',
      winner: status === 'finished' ? winner : null,
      curve, startAt: row.start_at, endAt: row.end_at,
    };
    kv.set(`battlescore:${id}`, { at: Date.now(), data });
    return data;
  }));

  // ── News ──────────────────────────────────────────────────────────────────
  // beginner-friendly buckets, derived from the real article text (no invention)
  const NEWS_CATS = [
    ['ipo', /\bIPO\b|initial public offering|goes public|public (debut|listing)|files to list|lists? on (the )?(NYSE|Nasdaq)/i],
    ['crypto', /bitcoin|crypto|ethereum|\bBTC\b|\bETH\b|blockchain|stablecoin|coinbase|binance/i],
    ['deals', /\bmerger\b|acquisitions?|acquires?|buyout|takeover|\bM&A\b|to buy .*(stake|unit|business)|joint venture/i],
    ['earnings', /earnings|quarterly (results|report)|(revenue|profit|sales) (beat|miss|jump|fell|rose)|guidance|forecasts? raised|\bEPS\b|results? beat/i],
    ['economy', /federal reserve|\bfed\b|inflation|jobs report|payrolls|\bGDP\b|interest rates?|rate (cut|hike)|tariffs?|treasury yields?|recession|consumer (prices|spending)/i],
    ['world', /\bchina|chinese|europe|european|\bindia\b|japan|germany|\bUK\b|britain|russia|ukraine|middle east|israel|iran|saudi|OPEC|global markets|geopolit/i],
  ];
  function newsCategory(a) {
    const t = `${a.title} ${a.raw_summary ?? ''}`;
    for (const [cat, re] of NEWS_CATS) if (re.test(t)) return cat;
    return 'us';
  }

  app.get('/api/news', wrap(req => {
    const limit = Math.min(120, Number(req.query.limit) || 60);
    const cat = String(req.query.cat ?? 'all');
    const mood = String(req.query.mood ?? 'all');       // all | Bullish | Bearish
    const topic = String(req.query.topic ?? 'all');     // AI subject tag
    const onlyBig = String(req.query.important ?? '') === '1';
    const all = db.prepare(
      'SELECT * FROM news ORDER BY published_at DESC LIMIT 300').all()
      .map(a => ({
        ...parseTickers(a),
        category: newsCategory(a),
        image: a.image === 'none' ? null : a.image, // 'none' = og:image lookup found nothing
      }));

    // counts are always for the full set so the chips never show a moving target
    const counts = { all: all.length };
    for (const a of all) counts[a.category] = (counts[a.category] ?? 0) + 1;
    const moodCounts = { all: all.length, Bullish: 0, Bearish: 0, Neutral: 0 };
    const topicCounts = { all: all.length };
    let importantCount = 0;
    for (const a of all) {
      if (a.sentiment) moodCounts[a.sentiment] = (moodCounts[a.sentiment] ?? 0) + 1;
      if (a.topic) topicCounts[a.topic] = (topicCounts[a.topic] ?? 0) + 1;
      if (a.importance === 'High' || a.importance === 'Medium') importantCount++;
    }

    const articles = all
      .filter(a => cat === 'all' || a.category === cat)
      .filter(a => mood === 'all' || a.sentiment === mood)
      .filter(a => topic === 'all' || a.topic === topic)
      .filter(a => !onlyBig || a.importance === 'High' || a.importance === 'Medium')
      .slice(0, limit);

    return {
      aiEngine: aiEngineStatus(),
      counts, moodCounts, topicCounts, importantCount,
      matched: articles.length,
      articles,
    };
  }));

  // ── Stocks ────────────────────────────────────────────────────────────────
  app.get('/api/stock/:symbol', wrap(async req => {
    const symbol = String(req.params.symbol).toUpperCase().trim();
    if (!/^[A-Z.^-]{1,8}$/.test(symbol)) throw new Error('invalid symbol');
    let quote = getQuote(symbol);
    if (!quote) {
      // no cached quote — must fetch once before we can show anything
      try { quote = await refreshQuote(symbol); } catch (err) { throw new Error(`no live data for ${symbol}`); }
    } else if (Date.now() - quote.updated_at > 60_000) {
      refreshQuote(symbol).catch(() => {}); // stale → refresh in background, don't block the page
    }
    const info = tickerInfo(symbol);
    ensureOHLCHistory(symbol).catch(() => {}); // background — chart is fetched separately via /api/history
    const facts = await fundamentals(symbol).catch(() => null);
    const shares = facts?.sharesOutstanding?.value;
    const marketCap = shares && quote?.price ? shares * quote.price : null;
    return {
      symbol,
      quote,
      info,
      marketCap,
      fundamentals: facts,
      history: db.prepare(
        'SELECT date, open, high, low, close FROM price_history WHERE symbol = ? ORDER BY date ASC'
      ).all(symbol).slice(-252),
      score: db.prepare('SELECT * FROM scores WHERE ticker = ?').get(symbol) ?? null,
      insiderTrades: db.prepare(
        'SELECT * FROM insider_trades WHERE ticker = ? ORDER BY filed_at DESC LIMIT 25').all(symbol).map(enrichTrade),
      politicianTrades: db.prepare(
        'SELECT * FROM politician_trades WHERE ticker = ? ORDER BY trade_date DESC LIMIT 25').all(symbol),
      politicianStats: (() => {
        const r = db.prepare(`
          SELECT COUNT(DISTINCT name) holders,
                 SUM(CASE WHEN side='Buy' THEN 1 ELSE 0 END) buys,
                 SUM(CASE WHEN side='Sell' THEN 1 ELSE 0 END) sells
          FROM politician_trades WHERE ticker = ? AND side IN ('Buy','Sell')`).get(symbol);
        const total = (r?.buys ?? 0) + (r?.sells ?? 0);
        return {
          holders: r?.holders ?? 0, buys: r?.buys ?? 0, sells: r?.sells ?? 0,
          sentiment: total ? Math.round((r.buys / total) * 100) : null, // % of trades that were buys
        };
      })(),
      fundActivity: db.prepare(`
        SELECT fc.*, f.name fund_name FROM fund_changes fc JOIN funds f ON f.cik = fc.cik
        WHERE fc.ticker = ? ORDER BY ABS(new_value-old_value) DESC LIMIT 25`).all(symbol),
      fundHolders: db.prepare(`
        SELECT fh.*, f.name fund_name, f.category, f.manager FROM fund_holdings fh
        JOIN funds f ON f.cik = fh.cik
        WHERE fh.ticker = ? AND fh.filing_id IN (
          SELECT MAX(id) FROM fund_filings GROUP BY cik
        ) ORDER BY fh.value DESC LIMIT 40`).all(symbol),
      relatedStocks: db.prepare(`
        WITH latest AS (SELECT MAX(id) id FROM fund_filings GROUP BY cik),
        holders AS (
          SELECT DISTINCT cik FROM fund_holdings
          WHERE ticker = ? AND filing_id IN (SELECT id FROM latest)
        )
        SELECT fh2.ticker, SUM(fh2.value) total, COUNT(DISTINCT fh2.cik) holders
        FROM fund_holdings fh2
        WHERE fh2.filing_id IN (SELECT id FROM latest)
          AND fh2.cik IN (SELECT cik FROM holders)
          AND fh2.ticker IS NOT NULL AND fh2.ticker <> ?
        GROUP BY fh2.ticker ORDER BY total DESC LIMIT 8`).all(symbol, symbol)
        .map(r => ({
          ...r,
          name: db.prepare('SELECT name FROM tickers WHERE ticker = ?').get(r.ticker)?.name ?? r.ticker,
          quote: getQuote(r.ticker) ?? null,
        })),
      news: db.prepare(`
        SELECT n.* FROM news n, json_each(n.tickers) j WHERE j.value = ?
        ORDER BY n.published_at DESC LIMIT 20`).all(symbol).map(parseTickers),
    };
  }));

  app.get('/api/search', wrap(req => {
    const q = String(req.query.q ?? '').trim();
    if (!q) return [];
    return db.prepare(
      'SELECT ticker, name FROM tickers WHERE ticker LIKE ? OR name LIKE ? LIMIT 12'
    ).all(`${q.toUpperCase()}%`, `%${q}%`);
  }));

  // Trending stocks for the Stocks landing — real signals, not a fixed list
  // ── Macro: rates, IPOs, dividends, crypto ─────────────────────────────────
  app.get('/api/macro', wrap(() => ({
    yields: kv.get('yield_curve'),
    ipos: kv.get('ipo_calendar'),
    dividends: kv.get('dividend_calendar'),
    crypto: kv.get('crypto'),
  })));

  // ── Institutional pressure: dark-pool volume + short interest ─────────────
  // Both feeds are published by FINRA on a deliberate lag; every response says
  // exactly which date its numbers belong to so the UI can never imply "now".
  app.get('/api/pressure', wrap(req => {
    const view = String(req.query.view ?? 'squeeze');   // squeeze | dark
    const limit = Math.min(60, Number(req.query.limit) || 25);

    // FINRA writes 999.99 into days-to-cover when the figure is not meaningful
    // (barely-traded OTC and foreign lines). Those would otherwise dominate the
    // list, so require a real live quote and a sane, tradeable cover figure.
    const squeezeRows = db.prepare(`
      SELECT si.symbol, si.name, si.settlement_date, si.short_shares, si.prev_short_shares,
             si.avg_daily_volume, si.days_to_cover, si.change_pct,
             q.price, q.change_pct today, q.volume, s.score
      FROM short_interest si
      JOIN quotes q ON q.symbol = si.symbol
      LEFT JOIN scores s ON s.ticker = si.symbol
      WHERE si.days_to_cover IS NOT NULL AND si.days_to_cover < 100
        AND si.short_shares > 0
        AND si.avg_daily_volume >= 100000
        AND q.price IS NOT NULL
      ORDER BY si.days_to_cover DESC
      LIMIT 400`).all();

    // A squeeze needs three things at once: a big short position relative to
    // normal volume, that position growing, and real trading interest today.
    const scored = squeezeRows.map(r => {
      const dtc = r.days_to_cover ?? 0;
      const rvol = r.avg_daily_volume && r.volume ? r.volume / r.avg_daily_volume : null;
      const cover = Math.min(50, dtc * 6);                      // days-to-cover weight
      const growing = Math.min(25, Math.max(0, (r.change_pct ?? 0) / 2));
      const active = rvol ? Math.min(25, (rvol - 1) * 18) : 0;   // today's volume vs normal
      const squeeze = Math.round(Math.max(0, cover + growing + Math.max(0, active)));
      return {
        ...r, rvol: rvol ? Number(rvol.toFixed(2)) : null,
        squeezeScore: Math.min(100, squeeze),
        level: squeeze >= 60 ? 'High' : squeeze >= 35 ? 'Elevated' : 'Normal',
      };
    }).sort((a, b) => b.squeezeScore - a.squeezeScore).slice(0, limit);

    const darkRows = db.prepare(`
      SELECT d.symbol, d.name, d.week_start, d.shares, d.trades, d.notional, d.venues,
             q.price, q.change_pct today, s.score
      FROM dark_pool d
      LEFT JOIN quotes q ON q.symbol = d.symbol
      LEFT JOIN scores s ON s.ticker = d.symbol
      WHERE d.shares > 0
      ORDER BY d.notional DESC
      LIMIT ?`).all(limit);

    const meta = {
      shortAsOf: db.prepare('SELECT MAX(settlement_date) d FROM short_interest').get()?.d ?? null,
      darkAsOf: db.prepare('SELECT MAX(week_start) d FROM dark_pool').get()?.d ?? null,
      shortSymbols: db.prepare('SELECT COUNT(*) c FROM short_interest').get().c,
      darkSymbols: db.prepare('SELECT COUNT(*) c FROM dark_pool').get().c,
    };
    return { view, meta, squeeze: scored, dark: darkRows };
  }));

  // ── Earnings calendar: who reports next ───────────────────────────────────
  // The Giant Money angle: flag companies whose own insiders were buying in the
  // month before the report, and whose stock the smart-money score already likes.
  app.get('/api/earnings', wrap(req => {
    const days = Math.min(14, Math.max(1, Number(req.query.days) || 7));
    const onlyMine = String(req.query.mine ?? '') === '1';
    const mine = String(req.query.symbols ?? '').split(',')
      .map(s => s.trim().toUpperCase()).filter(Boolean);

    const rows = db.prepare(`
      SELECT e.symbol, e.date, e.company, e.session, e.eps_forecast, e.last_eps,
             q.price, q.change_pct, s.score
      FROM earnings_calendar e
      LEFT JOIN quotes q ON q.symbol = e.symbol
      LEFT JOIN scores s ON s.ticker = e.symbol
      WHERE e.date >= date('now') AND e.date <= date('now', '+' || ? || ' day')
      ORDER BY e.date ASC, COALESCE(s.score, 0) DESC`).all(days);

    // insider buying in the 30 days before the report
    const insiderBuys = db.prepare(`
      SELECT COUNT(*) n, SUM(COALESCE(value, shares*COALESCE(price,0))) total
      FROM insider_trades
      WHERE ticker = ? AND side = 'Buy' AND trade_date >= date('now', '-30 day')`);

    const enriched = rows
      .filter(r => !onlyMine || mine.includes(r.symbol))
      .map(r => {
        const ib = insiderBuys.get(r.symbol);
        return {
          ...r,
          insiderBuys: ib?.n ?? 0,
          insiderBuyValue: ib?.total ?? 0,
          watched: mine.includes(r.symbol),
        };
      });

    // group by day for a calendar-shaped UI
    const byDay = new Map();
    for (const r of enriched) {
      if (!byDay.has(r.date)) byDay.set(r.date, []);
      byDay.get(r.date).push(r);
    }

    return {
      days: [...byDay.entries()].map(([date, list]) => ({
        date,
        count: list.length,
        // the ones actually worth showing first
        notable: list.filter(r => r.watched || r.insiderBuys > 0 || (r.score ?? 0) >= 60).slice(0, 12),
        all: list.slice(0, 40),
      })),
      total: enriched.length,
    };
  }));

  // ── Sector heatmap: how each part of the market moved today ───────────────
  // Averaged across every tracked stock in the sector that has a live quote.
  app.get('/api/sectors', wrap(() => {
    const rows = db.prepare(`
      SELECT t.sector,
             COUNT(*) n,
             AVG(q.change_pct) avg_change,
             SUM(CASE WHEN q.change_pct > 0 THEN 1 ELSE 0 END) up,
             SUM(CASE WHEN q.change_pct < 0 THEN 1 ELSE 0 END) down
      FROM quotes q JOIN tickers t ON t.ticker = q.symbol
      WHERE q.change_pct IS NOT NULL AND t.sector IS NOT NULL AND t.sector <> ''
      GROUP BY t.sector HAVING n >= 3
      ORDER BY avg_change DESC`).all();

    // best and worst name inside each sector, so a hot tile is explainable
    const edge = db.prepare(`
      SELECT q.symbol, q.change_pct FROM quotes q JOIN tickers t ON t.ticker = q.symbol
      WHERE t.sector = ? AND q.change_pct IS NOT NULL
      ORDER BY q.change_pct ${'DESC'} LIMIT 1`);
    const edgeAsc = db.prepare(`
      SELECT q.symbol, q.change_pct FROM quotes q JOIN tickers t ON t.ticker = q.symbol
      WHERE t.sector = ? AND q.change_pct IS NOT NULL
      ORDER BY q.change_pct ASC LIMIT 1`);

    return {
      sectors: rows.map(r => ({
        sector: r.sector,
        count: r.n,
        avgChange: Number(r.avg_change?.toFixed(2)),
        up: r.up, down: r.down,
        leader: edge.get(r.sector) ?? null,
        laggard: edgeAsc.get(r.sector) ?? null,
      })),
      asOf: Date.now(),
    };
  }));

  // ── Screener: filter the whole tracked universe ───────────────────────────
  app.get('/api/screener', wrap(req => {
    const sector = String(req.query.sector ?? 'all');
    const dir = String(req.query.dir ?? 'all');          // up | down | all
    const minScore = Number(req.query.minScore) || 0;
    const sort = String(req.query.sort ?? 'score');      // score | change | volume | name
    const limit = Math.min(200, Number(req.query.limit) || 60);

    const order = {
      score: 's.score DESC',
      change: 'q.change_pct DESC',
      loser: 'q.change_pct ASC',
      volume: 'q.volume DESC',
      name: 'q.symbol ASC',
    }[sort] ?? 's.score DESC';

    const rows = db.prepare(`
      SELECT q.symbol, q.name, q.price, q.change_pct, q.volume,
             t.sector, s.score, s.insider_sentiment
      FROM quotes q
      LEFT JOIN tickers t ON t.ticker = q.symbol
      LEFT JOIN scores  s ON s.ticker = q.symbol
      WHERE q.price IS NOT NULL
        AND (? = 'all' OR t.sector = ?)
        AND (? = 'all' OR (? = 'up' AND q.change_pct > 0) OR (? = 'down' AND q.change_pct < 0))
        AND COALESCE(s.score, 0) >= ?
      ORDER BY ${order} NULLS LAST
      LIMIT ?`).all(sector, sector, dir, dir, dir, minScore, limit);

    const sectors = db.prepare(`
      SELECT DISTINCT sector FROM tickers
      WHERE sector IS NOT NULL AND sector <> '' ORDER BY sector`).all().map(r => r.sector);

    const total = db.prepare(`
      SELECT COUNT(*) c FROM quotes q
      LEFT JOIN tickers t ON t.ticker = q.symbol
      LEFT JOIN scores  s ON s.ticker = q.symbol
      WHERE q.price IS NOT NULL
        AND (? = 'all' OR t.sector = ?)
        AND (? = 'all' OR (? = 'up' AND q.change_pct > 0) OR (? = 'down' AND q.change_pct < 0))
        AND COALESCE(s.score, 0) >= ?`).get(sector, sector, dir, dir, dir, minScore).c;

    return { rows, sectors, matched: total, shown: rows.length };
  }));

  app.get('/api/stocks-trending', wrap(() => {
    const d7 = ago(7), d1 = ago(1);
    const nameOf = t => db.prepare('SELECT name FROM tickers WHERE ticker = ?').get(t)?.name ?? t;
    const withQuote = rows => rows.map(r => {
      const q = getQuote(r.ticker);
      return { ...r, name: nameOf(r.ticker), price: q?.price ?? null, change_pct: q?.change_pct ?? null };
    });

    // 1) highest Giant Money Score (the platform's core signal)
    const topScore = withQuote(db.prepare(
      'SELECT ticker, score, insider_sentiment FROM scores ORDER BY score DESC LIMIT 12').all());

    // 2) biggest movers today (by live quote)
    const movers = db.prepare(`
      SELECT symbol ticker, name, price, change_pct FROM quotes
      WHERE change_pct IS NOT NULL AND price IS NOT NULL
      ORDER BY ABS(change_pct) DESC LIMIT 10`).all();

    // 3) most talked-about in the news (last 24h)
    const buzzing = withQuote(db.prepare(`
      SELECT j.value ticker, COUNT(*) mentions FROM news, json_each(news.tickers) j
      WHERE news.published_at >= ? GROUP BY j.value ORDER BY mentions DESC LIMIT 10`)
      .all(Date.now() - 864e5));

    // 4) heaviest smart-money buying (insiders + funds, last 7d)
    const smartBuys = withQuote(db.prepare(`
      SELECT ticker, SUM(COALESCE(value, shares*COALESCE(price,0))) total FROM insider_trades
      WHERE side='Buy' AND ticker IS NOT NULL AND trade_date >= ?
      GROUP BY ticker ORDER BY total DESC LIMIT 10`).all(d7));

    return { topScore, movers, buzzing, smartBuys };
  }));

  // ── Government contracts exposure (USAspending.gov, official + keyless) ───
  app.get('/api/gov/:symbol', wrap(async req => {
    const symbol = String(req.params.symbol).toUpperCase().trim();
    if (!/^[A-Z.-]{1,8}$/.test(symbol)) throw new Error('invalid symbol');
    const cacheKey = `gov:${symbol}`;
    const cached = kv.get(cacheKey);
    if (cached && Date.now() - cached.at < 24 * 3600 * 1000) return cached.data;

    const rawName = db.prepare('SELECT name FROM tickers WHERE ticker = ?').get(symbol)?.name;
    if (!rawName) return { symbol, awards: [], total: 0 };
    const searchName = rawName
      .replace(/\b(inc|corp|corporation|co|company|ltd|plc|holdings?|group|class [abc]|common stock|the)\b\.?/gi, '')
      .replace(/[^a-z0-9 ]/gi, ' ').replace(/\s+/g, ' ').trim();

    let data = { symbol, company: rawName, awards: [], total: 0 };
    try {
      const from = new Date(Date.now() - 3 * 365 * 864e5).toISOString().slice(0, 10);
      const res = await fetch('https://api.usaspending.gov/api/v2/search/spending_by_award/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(20000),
        body: JSON.stringify({
          filters: {
            recipient_search_text: [searchName.slice(0, 50)],
            award_type_codes: ['A', 'B', 'C', 'D'],
            time_period: [{ start_date: from, end_date: new Date().toISOString().slice(0, 10) }],
          },
          fields: ['Award ID', 'Recipient Name', 'Award Amount', 'Awarding Agency', 'Start Date', 'Description'],
          limit: 6, sort: 'Award Amount', order: 'desc',
        }),
      });
      if (res.ok) {
        const j = await res.json();
        const awards = (j?.results ?? []).map(a => ({
          id: a['Award ID'],
          recipient: a['Recipient Name'],
          amount: a['Award Amount'],
          agency: a['Awarding Agency'],
          start: a['Start Date'],
          description: String(a.Description ?? '').slice(0, 140),
        }));
        data = { symbol, company: rawName, awards, total: awards.reduce((s, a) => s + (a.amount ?? 0), 0) };
      }
    } catch (err) { logErr('gov', symbol, String(err).slice(0, 80)); }
    kv.set(cacheKey, { at: Date.now(), data });
    return data;
  }));

  // a single market index: current row + 1y history for the chart view
  app.get('/api/index/:symbol', wrap(async req => {
    const symbol = decodeURIComponent(req.params.symbol).toUpperCase();
    if (!/^\^[A-Z0-9]{1,6}$/.test(symbol)) throw new Error('invalid index');
    const row = db.prepare('SELECT * FROM market_indexes WHERE symbol = ?').get(symbol);
    if (!row) throw new Error('unknown index');
    const history = await historyRange(symbol, '1y').catch(() => []);
    return { index: row, history };
  }));

  // real daily OHLC for a chart time range (1m/6m/1y/3y/5y/max)
  app.get('/api/history/:symbol', wrap(async req => {
    const symbol = String(req.params.symbol).toUpperCase().trim();
    if (!/^[A-Z.^-]{1,8}$/.test(symbol)) throw new Error('invalid symbol');
    const range = ['1d', '1w', '1m', '6m', '1y', '3y', '5y', 'max'].includes(req.query.range) ? req.query.range : '1y';
    const history = await historyRange(symbol, range);
    return { symbol, range, history };
  }));

  // ── Landing page live data (marquee, stats, product shot) ────────────────
  app.get('/api/landing', wrap(() => {
    const indexes = db.prepare('SELECT * FROM market_indexes ORDER BY rowid').all();
    // marquee: latest real smart-money events across all sources
    const insiderEv = db.prepare(`
      SELECT insider_name who, company what, ticker, side, value, filed_at ts
      FROM insider_trades WHERE ticker IS NOT NULL AND value IS NOT NULL
      ORDER BY filed_at DESC LIMIT 8`).all()
      .map(e => ({
        kind: 'Form 4', ticker: e.ticker,
        who: e.who, did: `${e.side === 'Buy' ? 'bought' : 'sold'} ${e.what}`,
        amt: `${e.side === 'Buy' ? '+' : '−'}$${abbrev(e.value)}`, up: e.side === 'Buy',
      }));
    const fundEv = db.prepare(`
      SELECT f.manager who, f.name fund, fc.issuer, fc.ticker, fc.change_type,
             fc.new_value - fc.old_value dv
      FROM fund_changes fc JOIN funds f ON f.cik = fc.cik
      ORDER BY fc.id DESC LIMIT 8`).all()
      .map(e => ({
        kind: '13F', ticker: e.ticker,
        who: e.who !== '—' ? e.who : e.fund,
        did: `${{ new: 'opened', increased: 'added', reduced: 'trimmed', closed: 'exited' }[e.change_type]} ${titleCase(e.issuer)}`,
        amt: `${e.dv >= 0 ? '+' : '−'}$${abbrev(Math.abs(e.dv))}`, up: e.dv >= 0,
      }));
    const polEv = db.prepare(`
      SELECT name who, ticker, asset, side, amount FROM politician_trades
      WHERE side IN ('Buy','Sell') AND ticker IS NOT NULL
      ORDER BY trade_date DESC LIMIT 6`).all()
      .map(e => ({
        kind: 'PTR', ticker: e.ticker,
        who: e.who, did: `${e.side === 'Buy' ? 'bought' : 'sold'} ${e.ticker}`,
        amt: e.amount || (e.side === 'Buy' ? 'buy' : 'sell'), up: e.side === 'Buy',
      }));
    const marquee = [...insiderEv.slice(0, 5), ...fundEv.slice(0, 5), ...polEv.slice(0, 4)];

    const movers = db.prepare(`
      SELECT symbol, name, price, change_pct FROM quotes
      WHERE change_pct IS NOT NULL ORDER BY ABS(change_pct) DESC LIMIT 4`).all();

    const recentMoves = db.prepare(`
      SELECT f.cik, f.manager, f.name fund, fc.issuer, fc.ticker, fc.change_type,
             fc.new_value - fc.old_value dv, fc.filed_at
      FROM fund_changes fc JOIN funds f ON f.cik = fc.cik
      ORDER BY fc.filed_at DESC, ABS(fc.new_value - fc.old_value) DESC LIMIT 3`).all()
      .map(m => ({ ...m, photo: fundPhoto(m.cik, db.prepare('SELECT category FROM funds WHERE cik = ?').get(m.cik)?.category) }));

    const bigStats = {
      trackedValue: db.prepare(`
        SELECT SUM(total_value) v FROM fund_filings ff WHERE ff.id IN (
          SELECT MAX(id) FROM fund_filings GROUP BY cik)`).get().v ?? 0,
      funds: db.prepare('SELECT COUNT(*) c FROM funds').get().c,
      stocks: db.prepare('SELECT COUNT(*) c FROM tickers').get().c,
    };

    const topInvestors = db.prepare(`
      SELECT f.cik, f.name, f.manager, ff.total_value
      FROM funds f LEFT JOIN fund_filings ff ON ff.id = (
        SELECT id FROM fund_filings WHERE cik = f.cik ORDER BY filed_at DESC LIMIT 1)
      WHERE f.category = 'billionaire' AND ff.total_value IS NOT NULL
      ORDER BY ff.total_value DESC LIMIT 4`).all()
      .map(f => {
        const mv = db.prepare(`
          SELECT * FROM fund_changes WHERE cik = ?
          ORDER BY filed_at DESC, ABS(new_value-old_value) DESC LIMIT 1`).get(f.cik);
        return {
          ...f, photo: fundPhoto(f.cik, f.category),
          move: mv ? {
            label: `${{ new: 'New:', increased: 'Added', reduced: 'Trimmed', closed: 'Exited' }[mv.change_type]} ${mv.ticker ?? titleCase(mv.issuer).slice(0, 12)}`,
            up: mv.change_type === 'new' || mv.change_type === 'increased',
          } : null,
        };
      });

    const insiderTotals = db.prepare(`
      SELECT side, SUM(COALESCE(value, shares*COALESCE(price,0))) total
      FROM insider_trades WHERE trade_date >= date('now', '-7 day') GROUP BY side`).all()
      .reduce((a, r) => ({ ...a, [r.side]: r.total ?? 0 }), {});

    const latestPolitician = db.prepare(`
      SELECT * FROM politician_trades WHERE side IN ('Buy','Sell') AND ticker IS NOT NULL
      ORDER BY trade_date DESC LIMIT 1`).get();
    const latestPol = latestPolitician
      ? { ...latestPolitician, photo: photoUrl(latestPolitician.bioguide) }
      : null;

    const latestNews = db.prepare(`
      SELECT source, title, ai_summary, ai_why, sentiment, published_at FROM news
      WHERE ai_summary IS NOT NULL ORDER BY published_at DESC LIMIT 1`).get();

    // sample watchlist for the landing shot: what smart money watches most
    const watchlist = db.prepare(`
      SELECT q.symbol, q.name, q.price, q.change_pct, s.score
      FROM scores s JOIN quotes q ON q.symbol = s.ticker
      WHERE q.price IS NOT NULL ORDER BY s.score DESC LIMIT 6`).all();

    // ── section visuals (live) ──────────────────────────────────────────────
    // top1: real 13F buys/sells leaderboard (manager, issuer, ticker, $ delta)
    const top1Rows = db.prepare(`
      SELECT f.manager, f.name fund, f.cik, fc.issuer, fc.ticker, fc.change_type,
             fc.new_value - fc.old_value dv
      FROM fund_changes fc JOIN funds f ON f.cik = fc.cik
      WHERE fc.ticker IS NOT NULL
      ORDER BY fc.filed_at DESC, ABS(fc.new_value - fc.old_value) DESC LIMIT 4`).all()
      .map(r => ({
        who: r.manager !== '—' ? r.manager : r.fund,
        photo: personFor(r.cik)?.photo ?? null,
        issuer: titleCase(r.issuer), ticker: r.ticker,
        action: { new: 'Bought', increased: 'Added', reduced: 'Trimmed', closed: 'Exited' }[r.change_type],
        up: r.change_type === 'new' || r.change_type === 'increased',
        dv: r.dv,
      }));

    // politicians: recent disclosed trades with ticker (name, party, ticker, side, date)
    const politicianRows = db.prepare(`
      SELECT pt.name, pt.ticker, pt.side, pt.trade_date, pt.amount, pt.bioguide, l.party
      FROM politician_trades pt LEFT JOIN legislators l ON l.bioguide = pt.bioguide
      WHERE pt.side IN ('Buy','Sell') AND pt.ticker IS NOT NULL
      ORDER BY pt.trade_date DESC LIMIT 5`).all()
      .map(r => ({ ...r, photo: photoUrl(r.bioguide) }));

    // insiders: recent Form 4 open-market trades with role (name, title, ticker, side, value)
    const insiderRows = db.prepare(`
      SELECT company, ticker, insider_name, insider_title, side, value, trade_date
      FROM insider_trades WHERE ticker IS NOT NULL AND value IS NOT NULL
      ORDER BY filed_at DESC LIMIT 5`).all()
      .map(r => ({ ...r, company: titleCase(r.company) }));

    return {
      indexes, marquee, movers, recentMoves, bigStats, watchlist,
      topInvestors, insiderTotals, latestPolitician: latestPol, latestNews,
      top1Rows, politicianRows, insiderRows,
    };
  }));

  // ── Watchlist (user-selected symbols, live quotes + smart-money events) ───
  app.get('/api/watch', wrap(async req => {
    const symbols = String(req.query.symbols ?? '')
      .split(',').map(s => s.trim().toUpperCase())
      .filter(s => /^[A-Z.-]{1,8}$/.test(s)).slice(0, 20);
    if (!symbols.length) return { quotes: [], events: [] };

    const stale = symbols.filter(s => {
      const q = getQuote(s);
      return !q || Date.now() - q.updated_at > 120_000;
    });
    if (stale.length) {
      try { await refreshQuotesViaCNBC(stale); } catch (err) { logErr('watch', String(err).slice(0, 80)); }
    }

    const scoreOf = db.prepare('SELECT score, insider_sentiment FROM scores WHERE ticker = ?');
    const quotes = symbols.map(s => {
      const q = getQuote(s);
      return { symbol: s, ...(q ?? {}), ...(scoreOf.get(s) ?? {}) };
    });

    const ph = symbols.map(() => '?').join(',');
    const events = [
      ...db.prepare(`
        SELECT 'Form 4' kind, ticker, insider_name who, side,
               COALESCE(value, shares*COALESCE(price,0)) amt, trade_date date
        FROM insider_trades WHERE ticker IN (${ph}) ORDER BY filed_at DESC LIMIT 15`).all(...symbols),
      ...db.prepare(`
        SELECT '13F' kind, fc.ticker, f.name who, fc.change_type side,
               (fc.new_value - fc.old_value) amt, fc.filed_at date
        FROM fund_changes fc JOIN funds f ON f.cik = fc.cik
        WHERE fc.ticker IN (${ph}) ORDER BY fc.filed_at DESC LIMIT 15`).all(...symbols),
      ...db.prepare(`
        SELECT 'PTR' kind, ticker, name who, side, NULL amt, trade_date date
        FROM politician_trades WHERE ticker IN (${ph}) AND side IN ('Buy','Sell')
        ORDER BY trade_date DESC LIMIT 15`).all(...symbols),
    ].sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 30);

    return { quotes, events };
  }));

  function abbrev(v) {
    if (v == null) return '0';
    if (v >= 1e9) return (v / 1e9).toFixed(1) + 'B';
    if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(0) + 'K';
    return String(Math.round(v));
  }
  function titleCase(s) {
    return String(s ?? '').toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase());
  }

  // ── Scores & status ───────────────────────────────────────────────────────
  app.get('/api/scores', wrap(() =>
    db.prepare('SELECT * FROM scores ORDER BY score DESC LIMIT 50').all()
      .map(r => ({ ...r, components: safeJSON(r.components, {}) }))
  ));

  app.get('/api/status', wrap(() => ({
    time: Date.now(),
    aiEngine: aiEngineStatus(),
    counts: {
      news: one('SELECT COUNT(*) c FROM news'),
      summarized: one("SELECT COUNT(*) c FROM news WHERE ai_summary IS NOT NULL"),
      insiderTrades: one('SELECT COUNT(*) c FROM insider_trades'),
      politicianTrades: one('SELECT COUNT(*) c FROM politician_trades'),
      fundFilings: one('SELECT COUNT(*) c FROM fund_filings'),
      fundHoldings: one('SELECT COUNT(*) c FROM fund_holdings'),
      scores: one('SELECT COUNT(*) c FROM scores'),
      tickers: one('SELECT COUNT(*) c FROM tickers'),
    },
    jobs: db.prepare(`
      SELECT job, status, detail, started_at, finished_at FROM job_runs jr
      WHERE id = (SELECT MAX(id) FROM job_runs WHERE job = jr.job)
      ORDER BY finished_at DESC`).all(),
  })));

  function one(sql) { return db.prepare(sql).get().c; }
  function ago(days) { return new Date(Date.now() - days * 864e5).toISOString().slice(0, 10); }

  return app;
}
