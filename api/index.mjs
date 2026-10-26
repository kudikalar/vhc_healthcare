// Vercel serverless entry: runs the backend Express app in the same project so the browser keeps one
// origin (the session/CSRF cookies are SameSite=Strict).
//
// This file lives at the repository root so the Vercel Root Directory can be the repo root: the
// backend it imports (`../backend/...`) then sits INSIDE the root, which Vercel bundles reliably.
// (A `.mjs` extension forces ES-module parsing, since there is no root package.json declaring it.)
//
// Storage: Vercel's filesystem is per-instance and temporary. When an Upstash Redis store is connected
// (KV_REST_API_URL + KV_REST_API_TOKEN, or UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN), each
// request runs under a short store lock: load the latest data → handle → save if changed → unlock.
// This stops one instance from overwriting another's newer data (which used to drop fresh sign-in
// sessions). If the store cannot be read or written, the request fails with a retryable 503 instead of
// serving or saving stale data — and existing data is never replaced by the demo seed.
// Without a remote store, data lives in memory and is re-seeded whenever Vercel starts a new instance.
process.env.DB_IN_MEMORY ??= '1';
process.env.STORAGE_DIR ??= '/tmp/vhc-storage';
// Development mode exposes the simulated email/OTP codes the demo flows rely on (see README).
process.env.NODE_ENV = process.env.VHC_NODE_ENV || 'development';

const { createApp } = await import('../backend/src/app.js');
const { db, withDeterministicRandom } = await import('../backend/src/db.js');
const { resetAndSeed, runStartupMigrations } = await import('../backend/src/services/seed.js');
const { runJobs } = await import('../backend/src/services/jobs.js');
const { acquireLock, invalidateLocal, noteStoreError, releaseLock, remoteEnabled, syncIn, syncOut } = await import('../backend/src/services/remoteStore.js');

// Without a shared store, every instance has its own memory. Two things keep sign-in working anyway:
// signed session cookies any instance can verify, and identical demo data on every instance (seeded
// with fixed randomness). New changes still stay on the instance that made them until a store is added.
if (!remoteEnabled()) process.env.VHC_STATELESS_SESSIONS = '1';
const DEMO_SEED = 20261016;

const app = createApp();
let booted = false;

/** Runs under the store lock. Seeds only a store that has never been written. */
async function prepare() {
  const stored = await syncIn(); // throws on any store error — never fall back to seeding over real data
  if (remoteEnabled() && !stored) {
    resetAndSeed();
    await syncOut(true);
  } else if (!remoteEnabled() && db.all('users').length === 0) {
    withDeterministicRandom(DEMO_SEED, () => {
      resetAndSeed();
      runStartupMigrations();
    });
  }
  if (!booted) {
    // Existing data: add new platform records without touching existing accounts or policies.
    runStartupMigrations();
    runJobs();
    booted = true;
  }
}

function busy(res, message = 'The service is busy for a moment. Please try again.') {
  res.statusCode = 503;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Retry-After', '1');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({ error: message, details: { code: 'STORE_BUSY', retryable: true } }));
}

export default async function handler(req, res) {
  let token = null;
  try {
    token = await acquireLock();
    await prepare();
  } catch (e) {
    noteStoreError(e);
    console.error('[store] could not load data:', e.message);
    if (token) await releaseLock(token).catch(() => {});
    return busy(res);
  }

  let finished = false;
  const unlock = () => releaseLock(token).catch((e) => console.error('[store] unlock failed:', e.message));
  const end = res.end.bind(res);
  // Save before the response is released so Vercel does not freeze the function mid-write; release the
  // lock only after the save so no other request can read in between.
  res.end = (...args) => {
    if (finished) return end(...args);
    finished = true;
    syncOut()
      .then(() => end(...args))
      .catch((e) => {
        noteStoreError(e);
        invalidateLocal(); // drop the unsaved change; the next request reloads the saved data
        console.error('[store] save failed:', e.message);
        // The change was not saved, so do not report success.
        if (!res.headersSent) {
          res.statusCode = 503;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Retry-After', '1');
          end(JSON.stringify({ error: 'Your change could not be saved. Please try again.', details: { code: 'STORE_BUSY', retryable: true } }));
        } else end(...args);
      })
      .finally(unlock);
    return res;
  };
  // If the client disconnects before a response is produced, free the lock.
  res.on('close', () => { if (!finished) { finished = true; unlock(); } });
  return app(req, res);
}
