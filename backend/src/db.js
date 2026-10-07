// Lightweight JSON document store. All mutations go through tx(), which runs
// synchronously (so it is atomic within Node's single thread), persists on success
// and rolls back the whole state if the callback throws. This gives transactional
// updates for benefit balances, payments and payouts.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { now } from './clock.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
export const STORAGE_DIR = process.env.STORAGE_DIR || path.join(ROOT, 'storage', 'private');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const IN_MEMORY = process.env.DB_IN_MEMORY === '1';

export const COLLECTIONS = [
  'users', 'plans', 'hospitals', 'quotes', 'applications', 'documents', 'payments', 'payouts',
  'policies', 'healthClaims', 'lifeClaims', 'claimantAccounts', 'reinstatements',
  'notifications', 'auditLogs', 'exceptions', 'sessions', 'challenges', 'consents', 'loginAttempts',
  'familyMembers',
];

let state = null;
let depth = 0;

export function emptyState() {
  const s = { meta: { clockOffsetMs: 0, autoPayOutcome: 'success' }, counters: {} };
  for (const c of COLLECTIONS) s[c] = [];
  return s;
}

export function load() {
  if (state) return state;
  if (!IN_MEMORY && fs.existsSync(DB_FILE)) state = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  else state = emptyState();
  for (const c of COLLECTIONS) state[c] ||= [];
  state.counters ||= {};
  state.meta ||= { clockOffsetMs: 0 };
  return state;
}

let dirty = false;
/** True once since the last call if any transaction committed (used by remote persistence). */
export function takeDirty() {
  const d = dirty;
  dirty = false;
  return d;
}
/** Replace the in-memory state without persisting (used when loading from a remote store). */
export function adoptState(next) {
  state = next;
  for (const c of COLLECTIONS) state[c] ||= [];
  state.counters ||= {};
  state.meta ||= { clockOffsetMs: 0 };
}
export const snapshotState = () => JSON.stringify(load());

export function persist() {
  dirty = true;
  if (IN_MEMORY || !state) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${DB_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, DB_FILE);
}

export function replaceState(next) {
  state = next;
  persist();
}

export const meta = () => load().meta;
export const newId = (prefix) => `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
export function nextSeq(name) {
  const s = load();
  s.counters[name] = (s.counters[name] || 0) + 1;
  return s.counters[name];
}

export const db = {
  all: (c) => load()[c],
  find: (c, fn = () => true) => load()[c].filter(fn),
  findOne: (c, fn) => load()[c].find(fn) || null,
  get: (c, id) => load()[c].find((x) => x.id === id) || null,
  insert(c, obj) {
    const ts = now().toISOString();
    const rec = { id: obj.id || newId(c.slice(0, 3)), createdAt: ts, updatedAt: ts, ...obj };
    load()[c].push(rec);
    return rec;
  },
  touch(rec) {
    rec.updatedAt = now().toISOString();
    return rec;
  },
};

export function tx(fn) {
  load();
  if (depth > 0) return fn();
  const snapshot = JSON.stringify(state);
  depth++;
  try {
    const result = fn();
    persist();
    return result;
  } catch (e) {
    state = JSON.parse(snapshot);
    throw e;
  } finally {
    depth--;
  }
}
