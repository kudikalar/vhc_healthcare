// Vercel serverless entry for the demo deployment: runs the backend Express app in the same
// project so the browser keeps one origin (the session/CSRF cookies are SameSite=Strict).
// Vercel's filesystem is read-only and per-instance, so data lives in memory and is re-seeded
// on every cold start — demo only. Use a real host with a persistent disk for anything else.
process.env.DB_IN_MEMORY ??= '1';
process.env.STORAGE_DIR ??= '/tmp/vhc-storage';
// Development mode exposes the simulated email/OTP codes the demo flows rely on (see README).
process.env.NODE_ENV = process.env.VHC_NODE_ENV || 'development';

const { createApp } = await import('../../backend/src/app.js');
const { db } = await import('../../backend/src/db.js');
const { resetAndSeed } = await import('../../backend/src/services/seed.js');
const { runJobs } = await import('../../backend/src/services/jobs.js');

if (db.all('users').length === 0) resetAndSeed();
runJobs();

export default createApp();
