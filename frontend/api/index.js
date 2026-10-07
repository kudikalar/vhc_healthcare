// Vercel serverless entry: runs the backend Express app in the same project so the browser keeps one
// origin (the session/CSRF cookies are SameSite=Strict).
//
// Storage: Vercel's filesystem is per-instance and temporary. When an Upstash Redis store is connected
// (KV_REST_API_URL + KV_REST_API_TOKEN, or UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN), data is
// loaded from it before each request and saved after any change, so accounts and policies persist.
// Without it, data lives in memory and is re-seeded whenever Vercel starts a new instance.
process.env.DB_IN_MEMORY ??= '1';
process.env.STORAGE_DIR ??= '/tmp/vhc-storage';
// Development mode exposes the simulated email/OTP codes the demo flows rely on (see README).
process.env.NODE_ENV = process.env.VHC_NODE_ENV || 'development';

const { createApp } = await import('../../backend/src/app.js');
const { db } = await import('../../backend/src/db.js');
const { resetAndSeed } = await import('../../backend/src/services/seed.js');
const { runJobs } = await import('../../backend/src/services/jobs.js');
const { remoteEnabled, syncIn, syncOut } = await import('../../backend/src/services/remoteStore.js');

const app = createApp();

const ready = (async () => {
  let stored = false;
  try {
    stored = await syncIn();
  } catch (e) {
    console.error('[store] could not load saved data:', e.message);
  }
  if (!stored || db.all('users').length === 0) {
    resetAndSeed();
    if (remoteEnabled() && !stored) await syncOut(true).catch((e) => console.error('[store] initial save failed:', e.message));
  }
  runJobs();
})();

export default async function handler(req, res) {
  await ready;
  try {
    await syncIn();
  } catch (e) {
    console.error('[store] refresh failed, serving cached data:', e.message);
  }
  // Save before the response is released so Vercel does not freeze the function mid-write.
  const end = res.end.bind(res);
  res.end = (...args) => {
    syncOut()
      .catch((e) => console.error('[store] save failed:', e.message))
      .finally(() => end(...args));
    return res;
  };
  return app(req, res);
}
