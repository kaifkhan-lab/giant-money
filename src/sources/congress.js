// Members of Congress — official dataset from the unitedstates project
// (party, state, chamber, bioguide id). Photos come from the official
// congressional photo archive keyed by bioguide id.
import { db, kv } from '../db.js';
import { fetchJSON, log } from '../util.js';

const LEGISLATORS_URL = 'https://unitedstates.github.io/congress-legislators/legislators-current.json';
const HISTORICAL_URL = 'https://unitedstates.github.io/congress-legislators/legislators-historical.json';

export const photoUrl = bioguide =>
  bioguide ? `https://raw.githubusercontent.com/unitedstates/images/gh-pages/congress/225x275/${bioguide}.jpg` : null;

// normalize "Sheldon Whitehouse", "W. Whitehouse", "Whitehouse, Sheldon" style names
export function nameKey(name) {
  const parts = String(name ?? '')
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|hon|mr|mrs|ms|dr)\.?\b/g, '')
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1); // drop initials
  if (parts.length < 2) return parts.join(' ');
  return `${parts[0]} ${parts.at(-1)}`; // first + last
}

function ingestMembers(data, { replace = false } = {}) {
  const ins = db.prepare(`
    INSERT OR ${replace ? 'REPLACE' : 'IGNORE'} INTO legislators
      (bioguide, name_full, first, last, party, state, chamber, match_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction(() => {
    for (const p of data) {
      const term = p.terms?.at(-1);
      if (!term) continue;
      const first = p.name?.first ?? '';
      const last = p.name?.last ?? '';
      const full = p.name?.official_full ?? `${first} ${last}`;
      ins.run(
        p.id?.bioguide ?? null,
        full,
        first,
        last,
        term.party ?? '',
        term.state ?? '',
        term.type === 'sen' ? 'Senate' : 'House',
        nameKey(`${first} ${last}`)
      );
    }
  });
  tx();
}

function linkTrades() {
  const unlinked = db.prepare(
    'SELECT DISTINCT name FROM politician_trades WHERE bioguide IS NULL'
  ).all();
  const byKey = db.prepare('SELECT bioguide FROM legislators WHERE match_key = ?');
  const upd = db.prepare('UPDATE politician_trades SET bioguide = ? WHERE name = ?');
  let linked = 0;
  for (const { name } of unlinked) {
    let hit = byKey.get(nameKey(name));
    if (!hit) {
      // unique-last-name fallback (covers middle-name variants)
      const lastWord = nameKey(name).split(' ').at(-1);
      const rows = lastWord ? db.prepare(
        'SELECT bioguide FROM legislators WHERE match_key LIKE ?'
      ).all(`% ${lastWord}`) : [];
      if (rows.length === 1) hit = rows[0];
    }
    if (hit?.bioguide) { upd.run(hit.bioguide, name); linked++; }
  }
  return { linked, total: unlinked.length };
}

export async function refreshLegislators() {
  // current members always refresh their records; historical fill in gaps
  const data = await fetchJSON(LEGISLATORS_URL, { timeout: 30000 });
  ingestMembers(data, { replace: true });
  const n = db.prepare('SELECT COUNT(*) c FROM legislators').get().c;
  log('congress', `legislators refreshed: ${n} members on record`);

  let { linked, total } = linkTrades();

  // names still unmatched are usually former members (older disclosures) —
  // pull the historical dataset once to resolve them
  const histAt = kv.get('legislators_historical_at') ?? 0;
  if (linked < total && Date.now() - histAt > 30 * 24 * 3600 * 1000) {
    try {
      const hist = await fetchJSON(HISTORICAL_URL, { timeout: 120000, retries: 1 });
      ingestMembers(hist);
      kv.set('legislators_historical_at', Date.now());
      ({ linked, total } = linkTrades());
      log('congress', `historical members ingested (${hist.length})`);
    } catch (err) {
      log('congress', `historical dataset unavailable: ${String(err).slice(0, 80)}`);
    }
  }
  log('congress', `linked ${linked}/${total} politician names to member records`);
  return n;
}

export function legislatorInfo(bioguide) {
  return db.prepare('SELECT * FROM legislators WHERE bioguide = ?').get(bioguide);
}

// Official committee memberships (unitedstates project, same as the photos)
const COMMITTEES_URL = 'https://unitedstates.github.io/congress-legislators/committees-current.json';
const MEMBERSHIP_URL = 'https://unitedstates.github.io/congress-legislators/committee-membership-current.json';

export async function refreshCommittees() {
  const [committees, membership] = await Promise.all([
    fetchJSON(COMMITTEES_URL, { timeout: 30000 }),
    fetchJSON(MEMBERSHIP_URL, { timeout: 30000 }),
  ]);
  const nameOf = new Map();
  for (const c of committees) {
    nameOf.set(c.thomas_id, c.name);
    for (const sub of c.subcommittees ?? []) nameOf.set(c.thomas_id + sub.thomas_id, sub.name);
  }
  const byMember = new Map(); // bioguide -> [{name, role}]
  for (const [code, members] of Object.entries(membership)) {
    const cname = nameOf.get(code);
    if (!cname) continue;
    const isSub = code.length > 5; // subcommittee codes are parent+suffix
    for (const m of members) {
      if (!m?.bioguide) continue;
      if (!byMember.has(m.bioguide)) byMember.set(m.bioguide, []);
      byMember.get(m.bioguide).push({ name: cname, role: m.title ?? null, sub: isSub });
    }
  }
  const ins = db.prepare(
    'INSERT OR REPLACE INTO legislator_committees (bioguide, committees) VALUES (?, ?)'
  );
  const tx = db.transaction(() => {
    for (const [bio, list] of byMember) {
      // main committees first, dedupe by name
      const seen = new Set();
      const clean = list.sort((a, b) => Number(a.sub) - Number(b.sub))
        .filter(c => !seen.has(c.name) && seen.add(c.name));
      ins.run(bio, JSON.stringify(clean.slice(0, 12)));
    }
  });
  tx();
  log('congress', `committee memberships stored for ${byMember.size} members`);
  return byMember.size;
}

export function committeesFor(bioguide) {
  const row = db.prepare('SELECT committees FROM legislator_committees WHERE bioguide = ?').get(bioguide);
  try { return row ? JSON.parse(row.committees) : []; } catch { return []; }
}
