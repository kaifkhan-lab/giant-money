// Shared fetch helpers. Every byte of data in this app comes from a live
// remote source — there is no mock data path anywhere.

// SEC's fair-access policy asks filers' clients to declare a contact.
// Set SEC_USER_AGENT in .env (see .env.example) — e.g. "MyApp you@example.com".
const SEC_UA = process.env.SEC_USER_AGENT
  || 'GIANT-MONEY research contact@example.com';
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// SEC fair-access policy: max 10 req/s. We stay well under it.
let secChain = Promise.resolve();
const SEC_INTERVAL_MS = 150;

function secThrottle() {
  const next = secChain.then(() => new Promise(r => setTimeout(r, SEC_INTERVAL_MS)));
  secChain = next.catch(() => {});
  return next;
}

async function doFetch(url, { headers = {}, timeout = 20000, retries = 2, method = 'GET', body } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        body,
        headers,
        signal: AbortSignal.timeout(timeout),
        redirect: 'follow',
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status} for ${url}`);
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
    }
  }
  throw lastErr;
}

export async function fetchJSON(url, opts = {}) {
  const res = await doFetch(url, {
    ...opts,
    headers: { accept: 'application/json', 'user-agent': BROWSER_UA, ...opts.headers },
  });
  return res.json();
}

export async function fetchText(url, opts = {}) {
  const res = await doFetch(url, {
    ...opts,
    headers: { 'user-agent': BROWSER_UA, ...opts.headers },
  });
  return res.text();
}

// SEC endpoints (www.sec.gov, data.sec.gov, efts.sec.gov) — throttled + declared UA.
export async function fetchSEC(url, { json = true, ...opts } = {}) {
  await secThrottle();
  const res = await doFetch(url, {
    ...opts,
    headers: { 'user-agent': SEC_UA, 'accept-encoding': 'gzip, deflate', ...opts.headers },
  });
  return json ? res.json() : res.text();
}

export function sha1(str) {
  // tiny non-crypto stable hash is not enough for dedupe keys; use crypto
  return cryptoHash(str);
}
import { createHash } from 'node:crypto';
function cryptoHash(str) {
  return createHash('sha1').update(str).digest('hex');
}

export const now = () => Date.now();

export function pctChange(from, to) {
  if (!from || !to || !isFinite(from) || !isFinite(to) || from === 0) return null;
  return ((to - from) / Math.abs(from)) * 100;
}

export function log(scope, ...args) {
  console.log(`[${new Date().toISOString()}] [${scope}]`, ...args);
}

export function logErr(scope, ...args) {
  console.error(`[${new Date().toISOString()}] [${scope}] ERROR`, ...args);
}
