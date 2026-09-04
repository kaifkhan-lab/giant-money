// Real portraits + short bios for tracked investors, from the Wikipedia
// REST API (photo thumbnails are served by Wikimedia). Cached in the DB;
// people without a resolvable page simply render as monogram avatars.
import { kv } from '../db.js';
import { FUNDS } from './funds.js';
import { log, logErr } from '../util.js';

async function wikiSummary(title) {
  const res = await fetch(
    `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
    { headers: { accept: 'application/json', 'user-agent': 'GIANT-MONEY research' }, signal: AbortSignal.timeout(15000) }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return {
    title: data.title,
    photo: data.thumbnail?.source ?? data.originalimage?.source ?? null,
    bio: data.extract ?? null,
    url: data.content_urls?.desktop?.page ?? null,
  };
}

export async function refreshPeople() {
  let ok = 0;
  for (const fund of FUNDS) {
    const key = `person:${fund.cik}`;
    const cached = kv.get(key);
    if (cached && Date.now() - cached.at < 7 * 24 * 3600 * 1000) { ok++; continue; }
    const title = fund.wiki;
    if (!title) continue;
    try {
      const person = await wikiSummary(title);
      kv.set(key, { at: Date.now(), ...person });
      ok++;
    } catch (err) {
      logErr('people', fund.name, String(err).slice(0, 80));
    }
    await new Promise(r => setTimeout(r, 300));
  }
  log('people', `portraits/bios cached for ${ok}/${FUNDS.length} tracked investors`);
  return ok;
}

export function personFor(cik) {
  const p = kv.get(`person:${cik}`);
  return p ? { photo: p.photo, bio: p.bio, wiki: p.url } : null;
}
