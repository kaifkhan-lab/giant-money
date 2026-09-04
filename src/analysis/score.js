// Giant Money Score — ranks stocks by combined smart-money activity computed
// entirely from stored real data: SEC Form 4 insiders, SEC 13F funds,
// politician disclosures and analyzed news.
import { db } from '../db.js';
import { log } from '../util.js';

// midpoint of a disclosure amount range like "$1,001 - $15,000"
export function amountMidpoint(amount) {
  const nums = String(amount ?? '').match(/[\d,]+/g);
  if (!nums?.length) return 5000;
  const vals = nums.map(n => Number(n.replace(/,/g, ''))).filter(n => n > 0);
  if (!vals.length) return 5000;
  return vals.length > 1 ? (vals[0] + vals[1]) / 2 : vals[0];
}

function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 3600 * 1000).toISOString().slice(0, 10);
}

// squash a signed dollar-ish magnitude into -1..1
function squash(v, scale) {
  if (!v) return 0;
  const s = Math.sign(v);
  return s * Math.min(1, Math.log10(1 + Math.abs(v)) / Math.log10(1 + scale));
}

export function insiderSentimentLabel(buyVal, sellVal) {
  const total = buyVal + sellVal;
  if (total <= 0) return null;
  const ratio = buyVal / total;
  if (ratio >= 0.85) return 'Very Bullish';
  if (ratio >= 0.6) return 'Bullish';
  if (ratio > 0.4) return 'Neutral';
  if (ratio > 0.15) return 'Bearish';
  return 'Very Bearish';
}

export function computeScores() {
  const signals = new Map(); // ticker -> components
  const get = t => {
    if (!signals.has(t)) {
      signals.set(t, {
        insiderBuy: 0, insiderSell: 0, insiderTxns: 0,
        fundDelta: 0, fundEvents: 0,
        polBuy: 0, polSell: 0,
        newsSent: 0, mentions: 0,
      });
    }
    return signals.get(t);
  };

  // Insiders — last 21 days of open-market activity
  for (const r of db.prepare(`
    SELECT ticker, side, SUM(COALESCE(value, shares * COALESCE(price, 0))) v, COUNT(*) n
    FROM insider_trades
    WHERE ticker IS NOT NULL AND trade_date >= ?
    GROUP BY ticker, side
  `).all(daysAgo(21))) {
    const s = get(r.ticker);
    if (r.side === 'Buy') s.insiderBuy += r.v ?? 0; else s.insiderSell += r.v ?? 0;
    s.insiderTxns += r.n;
  }

  // Funds — position changes from the most recent 13F cycle (last 200 days)
  for (const r of db.prepare(`
    SELECT ticker, change_type, SUM(new_value - old_value) dv, COUNT(*) n
    FROM fund_changes
    WHERE ticker IS NOT NULL AND filed_at >= ?
    GROUP BY ticker, change_type
  `).all(daysAgo(200))) {
    const s = get(r.ticker);
    s.fundDelta += r.dv ?? 0;
    s.fundEvents += r.n;
  }

  // Politicians — last 120 days of disclosed trades
  for (const r of db.prepare(`
    SELECT ticker, side, amount FROM politician_trades
    WHERE ticker IS NOT NULL AND trade_date >= ?
  `).all(daysAgo(120))) {
    const s = get(r.ticker);
    const mid = amountMidpoint(r.amount);
    if (r.side === 'Buy') s.polBuy += mid;
    else if (r.side === 'Sell') s.polSell += mid;
  }

  // News — analyzed articles from the last 7 days
  for (const r of db.prepare(`
    SELECT tickers, sentiment, confidence FROM news
    WHERE ai_summary IS NOT NULL AND published_at >= ?
  `).all(Date.now() - 7 * 24 * 3600 * 1000)) {
    let list = [];
    try { list = JSON.parse(r.tickers ?? '[]'); } catch { /* ignore */ }
    const dir = r.sentiment === 'Bullish' ? 1 : r.sentiment === 'Bearish' ? -1 : 0;
    for (const t of list) {
      const s = get(t);
      s.mentions += 1;
      s.newsSent += dir * ((r.confidence ?? 50) / 100);
    }
  }

  // Combine
  const nameOf = db.prepare('SELECT name FROM tickers WHERE ticker = ?');
  const upsert = db.prepare(`
    INSERT INTO scores (ticker, name, score, components, insider_sentiment, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(ticker) DO UPDATE SET name=excluded.name, score=excluded.score,
      components=excluded.components, insider_sentiment=excluded.insider_sentiment,
      updated_at=excluded.updated_at
  `);

  let count = 0;
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM scores').run();
    for (const [ticker, s] of signals) {
      const insider = squash(s.insiderBuy - s.insiderSell, 5_000_000);      // $5M saturates
      const funds = squash(s.fundDelta, 500_000_000);                       // $500M saturates
      const politicians = squash(s.polBuy - s.polSell, 500_000);            // $500K saturates
      const news = Math.max(-1, Math.min(1, s.newsSent / 3));
      const activity = Math.min(1, (s.insiderTxns + s.fundEvents + s.mentions) / 20);

      const composite =
        0.32 * insider + 0.30 * funds + 0.14 * politicians + 0.14 * news + 0.10 * activity;
      const score = Math.round(50 + composite * 50);

      upsert.run(
        ticker,
        nameOf.get(ticker)?.name ?? ticker,
        score,
        JSON.stringify({
          insider: +insider.toFixed(3),
          funds: +funds.toFixed(3),
          politicians: +politicians.toFixed(3),
          news: +news.toFixed(3),
          activity: +activity.toFixed(3),
          raw: {
            insiderBuy: s.insiderBuy, insiderSell: s.insiderSell, insiderTxns: s.insiderTxns,
            fundDelta: s.fundDelta, fundEvents: s.fundEvents,
            polBuy: s.polBuy, polSell: s.polSell,
            newsSent: +s.newsSent.toFixed(2), mentions: s.mentions,
          },
        }),
        insiderSentimentLabel(s.insiderBuy, s.insiderSell),
        Date.now()
      );
      count++;
    }
  });
  tx();
  log('scores', `computed Giant Money Score for ${count} tickers`);
  return count;
}
