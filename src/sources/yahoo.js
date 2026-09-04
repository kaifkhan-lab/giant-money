// Yahoo Finance access.
//
// Yahoo's edge rejects Node's TLS fingerprint (429 for undici/fetch while the
// same request via curl succeeds), so requests go through the system curl
// binary with a persistent cookie jar. All Yahoo traffic is serialized with
// polite spacing, and a circuit breaker cools down on 429 instead of
// hammering the host (which extends the block).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { log } from '../util.js';

const exec = promisify(execFile);
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// same DATA_DIR override as the database, so a hosted volume holds both
const dataDir = process.env.DATA_DIR
  || join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');
mkdirSync(dataDir, { recursive: true });
const JAR = join(dataDir, 'yahoo-cookies.txt');

let sessionAt = 0;
let cooldownUntil = 0;
let cooldownStep = 60_000; // grows on repeated 429s, capped at 15 min
let chain = Promise.resolve();
const SPACING_MS = 400;

async function curlGet(url, extra = []) {
  const { stdout } = await exec('curl', [
    // Yahoo's edge 429s HTTP/2 from this IP but serves HTTP/1.1 fine
    '-s', '--http1.1', '--compressed', '--max-time', '20',
    '-A', UA,
    '-b', JAR, '-c', JAR,
    '-H', 'accept: application/json, text/html;q=0.9,*/*;q=0.8',
    '-H', 'accept-language: en-US,en;q=0.9',
    '-w', '\n__STATUS__%{http_code}',
    ...extra,
    url,
  ], { maxBuffer: 32 * 1024 * 1024 });
  const i = stdout.lastIndexOf('\n__STATUS__');
  return {
    status: Number(stdout.slice(i + 11).trim() || 0),
    body: stdout.slice(0, i),
  };
}

async function refreshSession() {
  try {
    await curlGet('https://finance.yahoo.com/quote/AAPL/', ['-L', '-o', '/dev/null']);
    sessionAt = Date.now();
    log('yahoo', 'session cookies refreshed');
  } catch { /* non-fatal; next request may still work */ }
}

export function yahooCoolingDown() {
  return Date.now() < cooldownUntil;
}

// On-demand real chart history (works for indexes like ^GSPC that Nasdaq/CNBC
// don't chart). Goes through curl and bypasses the cooldown gate because it's a
// rare user-triggered request, not the polling loop. Returns [{date,open,high,low,close}].
export async function yahooChartHistory(symbol, range = '1y', interval = '1d') {
  const turn = chain.then(() => new Promise(r => setTimeout(r, SPACING_MS)));
  chain = turn.catch(() => {});
  await turn;
  if (Date.now() - sessionAt > 12 * 3600 * 1000) await refreshSession();
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false`;
  const { status, body } = await curlGet(url);
  if (status !== 200) throw new Error(`HTTP ${status} for ${symbol} chart`);
  const r = JSON.parse(body)?.chart?.result?.[0];
  const ts = r?.timestamp ?? [];
  const q = r?.indicators?.quote?.[0] ?? {};
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.close?.[i] == null) continue;
    out.push({
      date: new Date(ts[i] * 1000).toISOString().slice(0, 10),
      open: q.open?.[i] ?? null, high: q.high?.[i] ?? null, low: q.low?.[i] ?? null, close: q.close[i],
    });
  }
  return out;
}

export async function yahooFetchJSON(url) {
  // serialize + space out all Yahoo requests app-wide
  const turn = chain.then(() => new Promise(r => setTimeout(r, SPACING_MS)));
  chain = turn.catch(() => {});
  await turn;

  if (yahooCoolingDown()) {
    throw new Error(`yahoo cooldown (${Math.ceil((cooldownUntil - Date.now()) / 1000)}s left)`);
  }
  if (Date.now() - sessionAt > 12 * 3600 * 1000) await refreshSession();

  for (let attempt = 0; attempt < 2; attempt++) {
    const { status, body } = await curlGet(url);
    if (status === 429 || status === 401 || status === 403) {
      if (attempt === 0) {
        await refreshSession();
        await new Promise(r => setTimeout(r, 1500));
        continue;
      }
      cooldownUntil = Date.now() + cooldownStep;
      log('yahoo', `rate limited — cooling down ${cooldownStep / 1000}s`);
      cooldownStep = Math.min(cooldownStep * 2, 15 * 60_000);
      throw new Error(`HTTP ${status} for ${url}`);
    }
    if (status !== 200) throw new Error(`HTTP ${status} for ${url}`);
    cooldownStep = 60_000; // healthy again
    return JSON.parse(body);
  }
}
