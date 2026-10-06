import { createApp } from './app.js';
import { db } from './db.js';
import { resetAndSeed } from './services/seed.js';
import { runJobs } from './services/jobs.js';

const PORT = Number(process.env.PORT) || 4000;

if (db.all('users').length === 0) {
  console.log('Empty database — loading fictional seed data');
  resetAndSeed();
}

createApp().listen(PORT, () => {
  console.log(`Vision Health Care API listening on http://localhost:${PORT}/api`);
  runJobs();
  setInterval(runJobs, 60 * 60 * 1000).unref();
});
