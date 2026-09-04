// AI news analysis.
// Primary engine: Anthropic Claude via the official SDK with structured JSON
// output. If no Anthropic credentials are available, a transparent local
// text-analysis fallback is used and labeled as such in the UI — summaries are
// always derived from the real article text, never invented.
import Anthropic from '@anthropic-ai/sdk';
import { db } from '../db.js';
import { unsummarizedNews, extractTickers } from '../sources/news.js';
import { isKnownTicker } from '../sources/quotes.js';
import { log, logErr } from '../util.js';

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';

let client = null;
let claudeAvailable = null; // null = untested

function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

const SCHEMA = {
  type: 'json_schema',
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      summary: {
        type: 'string',
        description: '1-2 short lines, simple beginner-friendly language: what happened.',
      },
      why_it_matters: {
        type: 'string',
        description: 'One short line: why this matters for everyday investors.',
      },
      sentiment: { type: 'string', enum: ['Bullish', 'Bearish', 'Neutral'] },
      confidence: { type: 'integer', description: 'Confidence 0-100 in the sentiment call.' },
      importance: {
        type: 'string',
        enum: ['High', 'Medium', 'Low'],
        description:
          'High = moves the broad market or a major company (Fed decisions, inflation prints, ' +
          'mega-cap earnings, big M&A, bankruptcies, major regulation). ' +
          'Medium = matters clearly to one sector or mid-size company. ' +
          'Low = routine filings, tiny companies, minor updates.',
      },
      impact_score: {
        type: 'integer',
        description: 'How market-moving this is, 0-100. Routine small-cap news is under 30.',
      },
      topic: {
        type: 'string',
        enum: ['Earnings', 'M&A', 'Fed & Economy', 'Regulation', 'Crypto', 'IPO',
               'Guidance', 'Legal', 'Product', 'Markets'],
        description: 'The single subject that best describes this article.',
      },
      tickers: {
        type: 'array',
        items: { type: 'string' },
        description: 'US stock tickers directly affected by this news. Empty if none.',
      },
    },
    required: ['summary', 'why_it_matters', 'sentiment', 'confidence',
               'importance', 'impact_score', 'topic', 'tickers'],
  },
};

const SYSTEM =
  'You analyze US financial news for a beginner-friendly smart-money dashboard. ' +
  'Summarize in at most 3 short lines of simple language, say why the news matters, ' +
  'judge market impact (Bullish/Bearish/Neutral) for the affected stocks or the broad market, ' +
  'rate how important the story really is, tag its subject, ' +
  'and list only tickers the article is clearly about. ' +
  'Be strict about importance: most wire stories are Low. Reserve High for news that ' +
  'genuinely moves the market or a household-name company. Do not speculate beyond the text.';

async function summarizeWithClaude(article) {
  const response = await getClient().messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: SYSTEM,
    output_config: { format: SCHEMA },
    messages: [
      {
        role: 'user',
        content: `Source: ${article.source}\nHeadline: ${article.title}\n\nArticle text/summary:\n${article.raw_summary || '(headline only)'}`,
      },
    ],
  });
  if (response.stop_reason === 'refusal') throw new Error('model refused');
  const text = response.content.find(b => b.type === 'text')?.text;
  const parsed = JSON.parse(text);
  return {
    summary: String(parsed.summary).trim(),
    why: String(parsed.why_it_matters ?? '').trim() || null,
    sentiment: parsed.sentiment,
    confidence: Math.max(0, Math.min(100, Number(parsed.confidence) || 0)),
    importance: parsed.importance,
    impact: Math.max(0, Math.min(100, Number(parsed.impact_score) || 0)),
    topic: parsed.topic,
    tickers: (parsed.tickers || []).map(t => String(t).toUpperCase()).filter(isKnownTicker),
    engine: 'claude',
  };
}

// ---- Local fallback: deterministic lexicon analysis of the real text ------

const POS = ['surge','soar','rally','beat','beats','record','profit','gain','gains','upgrade','upgraded','outperform','bullish','growth','buyback','dividend','strong','jump','jumps','rise','rises','boost','boosts','expansion','acquisition','breakthrough','approval','wins','win','deal','raised guidance','tops','higher'];
const NEG = ['plunge','tumble','slump','fall','falls','drop','drops','miss','misses','downgrade','downgraded','bearish','lawsuit','probe','investigation','recall','bankruptcy','layoff','layoffs','cuts','cut','warning','fraud','decline','declines','losses','loss','crash','fears','fear','selloff','sell-off','weak','lower','sink','sinks','slide','slides'];

// Subject tags, checked in order — first match wins. Derived from the real text.
const TOPIC_RULES = [
  ['Fed & Economy', /\b(federal reserve|fed |fomc|interest rate|rate cut|rate hike|inflation|cpi\b|ppi\b|jobs report|unemployment|gdp|recession|treasury yield)/i],
  ['M&A', /\b(acquire|acquisition|acquires|merger|merges|takeover|buyout|to buy .* for \$|stake in)/i],
  ['Earnings', /\b(earnings|eps\b|quarterly results|q[1-4] results|revenue rose|revenue fell|beats estimates|misses estimates|reports q)/i],
  ['Guidance', /\b(guidance|outlook|forecast|raises full-year|cuts full-year|warns)/i],
  ['IPO', /\b(ipo\b|initial public offering|goes public|direct listing|debuts on)/i],
  ['Crypto', /\b(bitcoin|ethereum|crypto|blockchain|stablecoin|digital asset)/i],
  ['Regulation', /\b(sec charges|regulator|regulation|antitrust|ftc\b|doj\b|probe|investigation|fine[sd]?\b|sanction)/i],
  ['Legal', /\b(lawsuit|sues|court|judge|settlement|verdict|appeal)/i],
  ['Product', /\b(launch|unveil|announces new|releases|rollout|partnership)/i],
];

// Signals that a story genuinely moves markets, weighted by how much they matter.
const IMPACT_RULES = [
  [34, /\b(federal reserve|fomc|interest rate|rate cut|rate hike|inflation|cpi\b|recession|gdp|jobs report)/i],
  [30, /\b(bankruptcy|chapter 11|halted|delisted|fraud|collapse|crash|plunge[sd]?)/i],
  [26, /\b(acquisition|acquires|merger|takeover|buyout)/i],
  [20, /\b(beats estimates|misses estimates|raises guidance|cuts guidance|record profit)/i],
  [18, /\b(apple|microsoft|nvidia|amazon|alphabet|google|meta|tesla|berkshire|jpmorgan|walmart|exxon)\b/i],
  [14, /\b(sec charges|antitrust|doj\b|ftc\b|recall|layoffs)/i],
  [10, /\b(s&p 500|nasdaq|dow jones|wall street|market selloff|rally)/i],
];

function classifyLocally(text) {
  const topic = TOPIC_RULES.find(([, re]) => re.test(text))?.[0] ?? 'Markets';
  let impact = 8; // baseline: a wire story nobody trades on
  for (const [pts, re] of IMPACT_RULES) if (re.test(text)) impact += pts;
  impact = Math.min(100, impact);
  const importance = impact >= 45 ? 'High' : impact >= 22 ? 'Medium' : 'Low';
  return { topic, impact, importance };
}

// Many feeds ship a headline and nothing else. Repeating that headline back as
// a "summary" is noise, so only return one when the feed actually gave us extra
// text to condense — otherwise null, and the card simply omits the block.
// Feeds repeat the headline at the start of the description, and Google-News
// style titles carry a " - Publisher" suffix that the description writes
// without the dash. Compare on letters/digits only so both forms strip cleanly.
const alnum = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function stripLeading(raw, phrase) {
  const p = alnum(phrase);
  if (!p || !alnum(raw).startsWith(p)) return raw;
  let seen = 0, i = 0;
  for (; i < raw.length && seen < p.length; i++) if (/[a-z0-9]/i.test(raw[i])) seen++;
  return raw.slice(i).replace(/^[\s—–\-|:]+/, '');
}

function condense(article) {
  const raw = String(article.raw_summary ?? '').replace(/\s+/g, ' ').trim();
  if (!raw) return null;
  const title = String(article.title ?? '').replace(/\s+/g, ' ').trim();
  const m = title.match(/^(.*?)\s+[-–|]\s+([^-–|]{2,40})$/); // "Headline - Publisher"
  const headline = m ? m[1] : title;
  const publisher = m ? m[2] : null;

  let body = stripLeading(raw, headline);
  if (publisher) body = stripLeading(body, publisher); // description repeats it too
  body = body.trim();

  if (alnum(body).length < 40) return null; // nothing beyond the headline
  return body.split(/(?<=[.!?])\s+/).slice(0, 2).join(' ').slice(0, 300).trim();
}

// A reason built from what we actually detected, not one canned sentence.
function localWhy({ topic, importance, impact, sentiment, tickers }) {
  const who = tickers.length
    ? tickers.slice(0, 3).join(', ')
    : 'no single named stock';
  const dir = sentiment === 'Bullish' ? 'leans positive'
    : sentiment === 'Bearish' ? 'leans negative'
    : 'is neutral in tone';
  const weight = importance === 'High' ? 'Rated market-moving'
    : importance === 'Medium' ? 'Worth a look'
    : 'Routine coverage';
  return `${topic} story · ${who}. Wording ${dir}. ${weight} (impact ${impact}/100).`;
}

function summarizeLocally(article) {
  const raw = `${article.title}. ${article.raw_summary ?? ''}`;
  const text = raw.toLowerCase();
  let score = 0;
  for (const w of POS) if (text.includes(w)) score++;
  for (const w of NEG) if (text.includes(w)) score--;
  const sentiment = score > 0 ? 'Bullish' : score < 0 ? 'Bearish' : 'Neutral';
  const confidence = Math.min(85, 35 + Math.abs(score) * 12);
  const triage = classifyLocally(raw);
  const tickers = extractTickers(`${article.title} ${article.raw_summary ?? ''}`);
  return {
    summary: condense(article),
    why: localWhy({ ...triage, sentiment, tickers }),
    sentiment,
    confidence,
    ...triage,
    tickers,
    engine: 'local',
  };
}

// ---- Queue processor -------------------------------------------------------

const saveSummary = db.prepare(`
  UPDATE news SET ai_summary = ?, ai_why = ?, sentiment = ?, confidence = ?, tickers = ?, ai_engine = ?,
                  importance = ?, impact_score = ?, topic = ?
  WHERE id = ?
`);

export async function processNewsQueue({ limit = 8 } = {}) {
  const articles = unsummarizedNews(limit);
  if (!articles.length) return 0;
  let done = 0;

  for (const article of articles) {
    let result = null;
    if (claudeAvailable !== false) {
      try {
        result = await summarizeWithClaude(article);
        claudeAvailable = true;
      } catch (err) {
        if (err instanceof Anthropic.AuthenticationError || /api key|x-api-key|credential/i.test(String(err))) {
          if (claudeAvailable === null) {
            log('ai', 'no Anthropic credentials — using labeled local analysis fallback');
          }
          claudeAvailable = false;
        } else if (err instanceof Anthropic.RateLimitError) {
          logErr('ai', 'rate limited, deferring queue');
          break; // retry next cycle
        } else {
          logErr('ai', String(err).slice(0, 200));
        }
      }
    }
    if (!result) result = summarizeLocally(article);

    // merge model tickers with validated regex-extracted tickers
    const merged = [...new Set([...(result.tickers ?? []), ...extractTickers(`${article.title} ${article.raw_summary ?? ''}`)])];
    // Claude may omit the triage fields on an older cached response — fall back
    // to the deterministic text classifier so every row is filterable.
    const triage = result.importance && result.topic
      ? { importance: result.importance, impact: result.impact ?? 0, topic: result.topic }
      : classifyLocally(`${article.title}. ${article.raw_summary ?? ''}`);
    saveSummary.run(
      result.summary, result.why ?? null, result.sentiment, result.confidence,
      JSON.stringify(merged), result.engine,
      triage.importance, triage.impact, triage.topic, article.id
    );
    done++;
  }
  log('ai', `summarized ${done} articles (engine: ${claudeAvailable ? 'claude' : 'local'})`);
  return done;
}

// Rows summarized before triage existed have no importance/topic. Classify them
// from their own real text so the News filters cover the whole archive.
const saveTriage = db.prepare(`
  UPDATE news SET importance = ?, impact_score = ?, topic = ?, ai_summary = ?, ai_why = ?
  WHERE id = ?
`);
export function backfillNewsTriage(limit = 2000) {
  // Only rows produced by the local engine are rewritten — a Claude summary is
  // never overwritten by the lexicon fallback.
  const rows = db.prepare(`
    SELECT id, title, raw_summary, sentiment, tickers, ai_summary FROM news
    WHERE importance IS NULL AND (ai_engine IS NULL OR ai_engine = 'local')
    ORDER BY published_at DESC LIMIT ?
  `).all(limit);
  if (!rows.length) return 0;
  const tx = db.transaction(list => {
    for (const r of list) {
      const t = classifyLocally(`${r.title}. ${r.raw_summary ?? ''}`);
      let tickers = [];
      try { tickers = JSON.parse(r.tickers ?? '[]'); } catch { /* keep empty */ }
      const why = localWhy({ ...t, sentiment: r.sentiment ?? 'Neutral', tickers });
      // this query only returns local-engine rows, so always regenerate the
      // summary with the current algorithm rather than trusting the old text
      saveTriage.run(t.importance, t.impact, t.topic, condense(r), why, r.id);
    }
  });
  tx(rows);
  log('ai', `re-analyzed ${rows.length} archived articles (topic, importance, why)`);
  return rows.length;
}

export function aiEngineStatus() {
  return claudeAvailable === true ? 'claude' : claudeAvailable === false ? 'local' : 'untested';
}
