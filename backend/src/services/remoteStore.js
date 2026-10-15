// Shared durable storage for serverless deployments (Vercel), using Redis — either Upstash's REST API or
// a redis:// connection (see detectStore below for the variable names recognised). When no store is
// configured every function is a no-op and the app keeps its normal file/in-memory storage; on Vercel
// that means each instance has separate data, which /api/health and the app's warning bar report.
//
// Model: the whole JSON document store is saved under one key with a version counter.
//
// Consistency (why sign-ins used to disappear): Vercel runs several instances, and each instance can
// serve several requests at the same time. Without coordination, a request holding an older copy of
// the data could save it over a newer one (for example right after a sign-in created a session), or two
// overlapping loads in one instance could leave it holding stale data while believing it was current.
// So every request now runs inside a short store lock (Redis SET NX PX + compare-and-delete release):
//   lock → load latest version → handle request → save only if the data actually changed → unlock.
// Requests are serialised per deployment, which is the right trade-off for a staging system on a
// single-document store. A real database replaces all of this in production.
import crypto from 'node:crypto';
import { adoptState, snapshotState, takeDirty } from '../db.js';

// Which store is connected. Vercel's integrations name variables differently (and allow a custom prefix):
//   Upstash for Redis / Vercel KV → <PREFIX>KV_REST_API_URL + <PREFIX>KV_REST_API_TOKEN (REST)
//   Upstash direct                → UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN (REST)
//   Redis (Redis Cloud) / KV_URL  → <PREFIX>REDIS_URL or <PREFIX>KV_URL (redis:// or rediss://, TCP)
function detectStore(env = process.env) {
  const keys = Object.keys(env).filter((k) => env[k]);
  const restUrl = keys.find((k) => /(^|_)KV_REST_API_URL$/.test(k)) || keys.find((k) => /UPSTASH_REDIS_REST_URL$/.test(k));
  if (restUrl) {
    const tokenKey = restUrl.replace(/URL$/, 'TOKEN');
    if (env[tokenKey]) return { kind: 'rest', url: env[restUrl], token: env[tokenKey], vars: [restUrl, tokenKey] };
  }
  const tcp = keys.find((k) => /(^|_)REDIS_URL$/.test(k) && /^rediss?:\/\//.test(env[k])) || keys.find((k) => /(^|_)KV_URL$/.test(k) && /^rediss?:\/\//.test(env[k]));
  if (tcp) return { kind: 'tcp', url: env[tcp], vars: [tcp] };
  return { kind: null, vars: [] };
}
const STORE = detectStore();
const PREFIX = process.env.VHC_STORE_PREFIX || 'vhc';
const LOCK_KEY = `${PREFIX}:lock`;
const LOCK_TTL_MS = 20_000; // safety expiry if an instance dies while holding the lock
const LOCK_WAIT_MS = 20_000; // give up (503, safe to retry) after this long
export const remoteEnabled = () => Boolean(STORE.kind);
const SERVERLESS = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);

let tcpClient = null;
async function tcp() {
  if (!tcpClient) {
    const { default: Redis } = await import('ioredis');
    tcpClient = new Redis(STORE.url, { maxRetriesPerRequest: 2, enableReadyCheck: true, lazyConnect: false });
    tcpClient.on('error', (e) => noteError(e));
  }
  return tcpClient;
}

async function redis(...command) {
  if (STORE.kind === 'tcp') return (await tcp()).call(...command.map(String));
  const res = await fetch(STORE.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${STORE.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) throw new Error(`Remote store error: ${body.error || res.status}`);
  return body.result;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let localVersion = null;
let lastSaved = null; // JSON of the state as last loaded/saved — used to skip saves when nothing changed
// Reported by /api/health (variable names only, never values).
export const storeStatus = {
  mode: STORE.kind ? `redis-${STORE.kind}` : 'local', connectedVia: STORE.vars,
  shared: Boolean(STORE.kind),
  warning: !STORE.kind && SERVERLESS ? 'No shared data store is connected. Each serverless instance keeps its own data, so sign-ins and changes are lost between requests. Connect Upstash Redis to this Vercel project.' : null,
  version: null, lastError: null, lastErrorAt: null, lockWaitMs: 0,
};
function noteError(e) { storeStatus.lastError = e.message; storeStatus.lastErrorAt = new Date().toISOString(); }

/** Acquires the store lock; returns a token (null when no remote store). Throws when the store stays busy. */
export async function acquireLock() {
  if (!remoteEnabled()) return null;
  const token = crypto.randomUUID();
  const started = Date.now();
  let delay = 10;
  for (;;) {
    const ok = await redis('SET', LOCK_KEY, token, 'NX', 'PX', LOCK_TTL_MS);
    if (ok === 'OK') { storeStatus.lockWaitMs = Date.now() - started; return token; }
    if (Date.now() - started > LOCK_WAIT_MS) throw new Error('Store is busy');
    await sleep(delay + Math.floor(Math.random() * 10));
    delay = Math.min(delay * 2, 150);
  }
}

/** Releases the lock only if we still own it (an expired lock may already belong to someone else). */
export async function releaseLock(token) {
  if (!token) return;
  await redis('EVAL', "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end", 1, LOCK_KEY, token);
}

/**
 * Loads the latest saved state if another instance has written since we last looked. Call while
 * holding the lock. Returns false when nothing has ever been stored. Errors propagate: the caller must
 * not serve or save stale data.
 */
export async function syncIn() {
  if (!remoteEnabled()) return true;
  const v = await redis('GET', `${PREFIX}:ver`);
  if (v == null) return false;
  if (String(v) !== localVersion) {
    const json = await redis('GET', `${PREFIX}:state`);
    if (!json) throw new Error('Stored version exists but the state is missing');
    adoptState(JSON.parse(json));
    lastSaved = json;
    localVersion = String(v);
    storeStatus.version = localVersion;
  }
  takeDirty();
  return true;
}

/** Saves the state if it changed during this request. Call while holding the lock. */
export async function syncOut(force = false) {
  if (!remoteEnabled()) return false;
  const dirty = takeDirty();
  if (!dirty && !force) return false;
  const json = snapshotState();
  if (!force && json === lastSaved) return false; // a transaction ran but nothing actually changed
  await redis('SET', `${PREFIX}:state`, json); // state first, so a reader never sees a new version with old data
  const v = await redis('INCR', `${PREFIX}:ver`);
  localVersion = String(v);
  lastSaved = json;
  storeStatus.version = localVersion;
  return true;
}

export { noteError as noteStoreError };

/** Forget the local copy so the next request reloads it (used when a save failed: never keep unsaved changes). */
export function invalidateLocal() {
  localVersion = null;
  lastSaved = null;
}

// Private document bodies (base64). Files are also written to local disk by the documents route.
export async function saveBlob(id, buffer) {
  if (!remoteEnabled()) return;
  await redis('SET', `${PREFIX}:doc:${id}`, buffer.toString('base64'));
}
export async function loadBlob(id) {
  if (!remoteEnabled()) return null;
  const b64 = await redis('GET', `${PREFIX}:doc:${id}`);
  return b64 ? Buffer.from(b64, 'base64') : null;
}
