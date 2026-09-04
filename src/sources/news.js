// Financial news — live RSS feeds from multiple real publishers.
import { XMLParser } from 'fast-xml-parser';
import { db } from '../db.js';
import { fetchText, sha1, log, logErr } from '../util.js';
import { isKnownTicker } from './quotes.js';

const FEEDS = [
  { source: 'Yahoo Finance', url: 'https://finance.yahoo.com/news/rssindex' },
  { source: 'CNBC Top News', url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html' },
  { source: 'CNBC Finance', url: 'https://www.cnbc.com/id/10000664/device/rss/rss.html' },
  { source: 'MarketWatch', url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories' },
  { source: 'MarketWatch Real-time', url: 'https://feeds.content.dowjones.io/public/rss/mw_realtimeheadlines' },
  { source: 'Seeking Alpha', url: 'https://seekingalpha.com/market_currents.xml' },
  { source: 'Google News Business', url: 'https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=en-US&gl=US&ceid=US:en' },
  { source: 'Business Insider Markets', url: 'https://markets.businessinsider.com/rss/news' },
  // Every feed below was checked for real items before being added; sources
  // that returned an empty or placeholder document were left out on purpose.
  { source: 'WSJ Markets', url: 'https://feeds.content.dowjones.io/public/rss/RSSMarketsMain' },
  { source: 'WSJ Business', url: 'https://feeds.content.dowjones.io/public/rss/WSJcomUSBusiness' },
  { source: 'MarketWatch Bulletins', url: 'https://feeds.content.dowjones.io/public/rss/mw_bulletins' },
  { source: 'CNBC Markets', url: 'https://www.cnbc.com/id/20910258/device/rss/rss.html' },
  { source: 'CNBC Investing', url: 'https://www.cnbc.com/id/15839069/device/rss/rss.html' },
  { source: 'CNBC Earnings', url: 'https://www.cnbc.com/id/15839135/device/rss/rss.html' },
  { source: 'Nasdaq Markets', url: 'https://www.nasdaq.com/feed/rssoutbound?category=Markets' },
  { source: 'Investing.com', url: 'https://www.investing.com/rss/news_25.rss' },
  { source: 'Business Wire', url: 'https://feed.businesswire.com/rss/home/?rss=G1QFDERJXkJeGVtRVQ==' },
  // primary-source announcements — these move the whole market, not one stock
  { source: 'Federal Reserve', url: 'https://www.federalreserve.gov/feeds/press_all.xml' },
  { source: 'SEC Press', url: 'https://www.sec.gov/news/pressreleases.rss' },
  { source: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
];

const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });

function stripHtml(s) {
  return String(s ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;|&rsquo;/g, "'").replace(/&quot;|&ldquo;|&rdquo;/g, '"').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function asArray(x) {
  return x == null ? [] : Array.isArray(x) ? x : [x];
}

// Extract US tickers actually referenced in the text, validated against the
// SEC ticker universe. No guessing.
export function extractTickers(text) {
  const found = new Set();
  const t = String(text ?? '');
  for (const m of t.matchAll(/\$([A-Z]{1,5})\b/g)) {
    if (isKnownTicker(m[1])) found.add(m[1]);
  }
  for (const m of t.matchAll(/\((?:NYSE|NASDAQ|Nasdaq|AMEX|NYSEARCA)\s*:\s*([A-Za-z.]{1,6})\)/g)) {
    const sym = m[1].toUpperCase();
    if (isKnownTicker(sym)) found.add(sym);
  }
  return [...found];
}

const insertNews = db.prepare(`
  INSERT OR IGNORE INTO news (guid, source, title, link, published_at, raw_summary, tickers, image, created_at)
  VALUES (@guid, @source, @title, @link, @published_at, @raw_summary, @tickers, @image, @created_at)
`);
const backfillImage = db.prepare(
  "UPDATE news SET image = @image WHERE guid = @guid AND (image IS NULL OR image = '')"
);

// thumbnail from RSS media tags (media:content / media:thumbnail / enclosure)
function mediaUrl(item) {
  const cands = [
    item.thumbnail, item.content, item.enclosure,
    item.group?.thumbnail, item.group?.content,
  ];
  for (const c of cands) {
    for (const v of Array.isArray(c) ? c : [c]) {
      const u = v?.['@_url'];
      if (u && /^https?:\/\//.test(u)) return String(u).slice(0, 500);
    }
  }
  return null;
}

export async function fetchNews() {
  let inserted = 0;

  // Fetching one feed at a time meant the whole run took as long as the sum of
  // every feed's timeout — with this many sources that could outlast the job's
  // own 3-minute interval. Five at a time keeps a slow host from stalling the
  // rest while staying polite to each publisher.
  const readFeed = async feed => {
    try {
      const xml = await fetchText(feed.url, { timeout: 15000, retries: 1 });
      const doc = parser.parse(xml);
      const items = asArray(doc?.rss?.channel?.item).concat(asArray(doc?.feed?.entry));
      for (const item of items.slice(0, 30)) {
        const title = stripHtml(item.title?.['#text'] ?? item.title);
        if (!title) continue;
        const link =
          typeof item.link === 'string' ? item.link
          : item.link?.['@_href'] ?? asArray(item.link)[0]?.['@_href'] ?? item.link?.['#text'] ?? '';
        const rawGuid = item.guid?.['#text'] ?? item.guid ?? item.id ?? link ?? title;
        const desc = stripHtml(item.description ?? item.summary ?? '').slice(0, 1200);
        const pub = item.pubDate ?? item.published ?? item.updated ?? null;
        const publishedAt = pub ? Date.parse(pub) || Date.now() : Date.now();
        // skip stale items (older than 3 days)
        if (Date.now() - publishedAt > 3 * 24 * 3600 * 1000) continue;
        const guid = sha1(String(rawGuid));
        const image = mediaUrl(item);
        const res = insertNews.run({
          guid,
          source: feed.source,
          title,
          link: String(link),
          published_at: publishedAt,
          raw_summary: desc,
          tickers: JSON.stringify(extractTickers(`${title} ${desc}`)),
          image,
          created_at: Date.now(),
        });
        inserted += res.changes;
        // older stored copy of this story may predate image support
        if (!res.changes && image) backfillImage.run({ guid, image });
      }
    } catch (err) {
      logErr('news', feed.source, String(err));
    }
  };

  for (let i = 0; i < FEEDS.length; i += 5) {
    await Promise.allSettled(FEEDS.slice(i, i + 5).map(readFeed));
  }

  // bound the table — more feeds means more articles worth keeping
  db.prepare(
    'DELETE FROM news WHERE id NOT IN (SELECT id FROM news ORDER BY published_at DESC LIMIT 3000)'
  ).run();
  log('news', `inserted ${inserted} new articles`);
  return inserted;
}

// Pull the real og:image thumbnail from the article page itself (publishers
// like Yahoo/CNBC/SA don't put images in their RSS). A few per cycle.
async function fetchOgImage(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        accept: 'text/html',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const html = (await res.text()).slice(0, 80000);
    const m =
      html.match(/property=["']og:image["'][^>]*content=["']([^"']+)/i) ||
      html.match(/content=["']([^"']+)["'][^>]*property=["']og:image["']/i) ||
      html.match(/name=["']twitter:image["'][^>]*content=["']([^"']+)/i);
    let u = m?.[1];
    if (u) u = String(u).replace(/&amp;/g, '&').slice(0, 500);
    // reject generic site-wide placeholder images (e.g. Seeking Alpha's default og card)
    if (!u || !/^https?:\/\//.test(u) || /\/assets\/og_image|default[-_]?og|og[-_]?default|logo/i.test(u)) return null;
    return u;
  } catch {
    return null;
  }
}

export async function enrichNewsImages(limit = 12) {
  const rows = db.prepare(`
    SELECT id, link FROM news
    WHERE (image IS NULL OR image = '') AND link LIKE 'http%'
    ORDER BY published_at DESC LIMIT ?`).all(limit);
  const upd = db.prepare('UPDATE news SET image = ? WHERE id = ?');
  let n = 0;
  for (const r of rows) {
    const img = await fetchOgImage(r.link);
    // mark misses so we don't retry the same article forever
    upd.run(img ?? 'none', r.id);
    if (img) n++;
  }
  if (n) log('news', `thumbnails fetched for ${n}/${rows.length} articles`);
  return n;
}

// ai_engine is the "has been analyzed" marker, not ai_summary: a headline-only
// article legitimately ends up with a NULL summary, and keying off that would
// put it back in the queue forever.
export function unsummarizedNews(limit = 10) {
  return db.prepare(
    'SELECT * FROM news WHERE ai_engine IS NULL ORDER BY published_at DESC LIMIT ?'
  ).all(limit);
}
