// Account handling: password hashing, sessions, and the request helpers the
// API routes use.
//
// Deliberate choices, because this is the one part of the app where a mistake
// is expensive:
//   · passwords are never stored — only scrypt(password, random salt)
//   · the session cookie is a random token; the DB keeps only its SHA-256, so a
//     database leak cannot be replayed as a login
//   · comparisons use timingSafeEqual, never ===
//   · a failed login never reveals whether the email exists
//   · repeated failures from one IP are slowed down
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { db } from './db.js';

const COOKIE = 'gm_session';
const SESSION_DAYS = 30;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

// ── password hashing ───────────────────────────────────────────────────────
export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const hash = scryptSync(password, salt, SCRYPT.keylen, SCRYPT).toString('hex');
  return { hash, salt };
}

function passwordMatches(password, storedHash, salt) {
  const candidate = scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  const stored = Buffer.from(storedHash, 'hex');
  // length check first — timingSafeEqual throws on a mismatch
  return stored.length === candidate.length && timingSafeEqual(stored, candidate);
}

// ── sessions ───────────────────────────────────────────────────────────────
const sha256 = s => createHash('sha256').update(s).digest('hex');

export function createSession(userId) {
  const token = randomBytes(32).toString('hex');
  const now = Date.now();
  db.prepare(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
  ).run(sha256(token), userId, now, now + SESSION_DAYS * 86400e3);
  return token;
}

export function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

export function userForToken(token) {
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.id, u.email, u.name, u.photo, u.created_at, s.expires_at
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?`).get(sha256(token));
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
    return null;
  }
  const { expires_at, ...user } = row;
  return user;
}

// Express 5 ships no cookie parser and this is the only cookie we read, so a
// tiny parser is preferable to another dependency.
export function readCookie(req, name = COOKIE) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export function setSessionCookie(res, token, req) {
  // `secure` only when actually served over https, otherwise the cookie would
  // be dropped on a plain-http localhost and login would silently fail
  const https = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie',
    `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}` +
    (https ? '; Secure' : ''));
}

export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

export const currentUser = req => userForToken(readCookie(req));

// ── validation ─────────────────────────────────────────────────────────────
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function validateCredentials(email, password) {
  const e = String(email ?? '').trim().toLowerCase();
  const p = String(password ?? '');
  if (!EMAIL_RE.test(e)) return { error: 'Enter a valid email address.' };
  if (p.length < 8) return { error: 'Use at least 8 characters for your password.' };
  if (p.length > 200) return { error: 'That password is too long.' };
  return { email: e, password: p };
}

// ── brute-force slowdown ───────────────────────────────────────────────────
// In-memory is fine here: the window is short and a restart only forgives
// attackers a few seconds of progress.
const attempts = new Map();
const WINDOW = 15 * 60e3;
const MAX_ATTEMPTS = 8;

export function tooManyAttempts(ip) {
  const rec = attempts.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.first > WINDOW) { attempts.delete(ip); return false; }
  return rec.n >= MAX_ATTEMPTS;
}

export function noteFailedAttempt(ip) {
  const rec = attempts.get(ip);
  if (!rec || Date.now() - rec.first > WINDOW) attempts.set(ip, { n: 1, first: Date.now() });
  else rec.n++;
}

export const clearAttempts = ip => attempts.delete(ip);

// ── accounts ───────────────────────────────────────────────────────────────
export function createUser({ email, password, name }) {
  const { hash, salt } = hashPassword(password);
  const info = db.prepare(`
    INSERT INTO users (email, name, pw_hash, pw_salt, created_at)
    VALUES (?, ?, ?, ?, ?)`).run(email, name?.trim()?.slice(0, 40) || null, hash, salt, Date.now());
  return { id: info.lastInsertRowid, email, name: name || null, photo: null };
}

export function authenticate(email, password) {
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!row) {
    // Hash anyway so a missing account takes the same time as a wrong password
    // — otherwise response timing reveals which emails are registered.
    hashPassword(password);
    return null;
  }
  if (!passwordMatches(password, row.pw_hash, row.pw_salt)) return null;
  db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(Date.now(), row.id);
  return { id: row.id, email: row.email, name: row.name, photo: row.photo };
}

export function emailTaken(email) {
  return !!db.prepare('SELECT 1 FROM users WHERE email = ?').get(email);
}

// ── per-account data ───────────────────────────────────────────────────────
export function getUserData(userId, key) {
  const row = db.prepare('SELECT value FROM user_data WHERE user_id = ? AND key = ?').get(userId, key);
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

export function setUserData(userId, key, value) {
  db.prepare(`
    INSERT INTO user_data (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(userId, key, JSON.stringify(value ?? null), Date.now());
}

// housekeeping — expired sessions are dead weight
export function purgeExpiredSessions() {
  return db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()).changes;
}
