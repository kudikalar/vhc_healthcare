// Development-only tooling: reset/seed, controllable test clock, scheduled jobs.
// Mounted only when NODE_ENV !== 'production'.
import { Router } from 'express';
import { meta, tx } from '../db.js';
import { now, today } from '../clock.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { bad } from '../utils/errors.js';
import { isValidDate, toDate } from '../utils/dates.js';
import { resetAndSeed } from '../services/seed.js';
import { runJobs } from '../services/jobs.js';
import { audit } from '../services/audit.js';

const r = Router();
const clockInfo = () => ({ now: now().toISOString(), today: today(), offsetDays: Math.round((meta().clockOffsetMs || 0) / 86400000), autoPayOutcome: meta().autoPayOutcome || 'success' });

r.get('/clock', (req, res) => res.json(clockInfo()));

r.use(authenticate, requireRole('admin'));

r.post('/reset', (req, res) => {
  const out = resetAndSeed();
  res.json({ message: 'Database reset and seeded', ...out });
});

r.post('/clock', (req, res) => {
  const { advanceDays, setDate, reset } = req.body || {};
  tx(() => {
    const m = meta();
    if (reset) m.clockOffsetMs = 0;
    else if (setDate) {
      if (!isValidDate(setDate)) throw bad('setDate must be YYYY-MM-DD');
      const realNow = Date.now();
      const target = toDate(setDate).getTime() + (realNow % 86400000);
      m.clockOffsetMs = target - realNow;
    } else if (Number.isInteger(advanceDays)) m.clockOffsetMs = (m.clockOffsetMs || 0) + advanceDays * 86400000;
    else throw bad('Provide advanceDays, setDate or reset');
    audit(req.user, 'TEST_CLOCK_CHANGED', 'system', null, { today: today() });
  });
  const jobs = runJobs();
  res.json({ ...clockInfo(), jobs });
});

r.post('/autopay-outcome', (req, res) => {
  const o = req.body?.outcome;
  if (!['success', 'failure'].includes(o)) throw bad('outcome must be success or failure');
  tx(() => { meta().autoPayOutcome = o; });
  res.json(clockInfo());
});

r.post('/run-jobs', (req, res) => res.json(runJobs()));

export default r;
