import { Router } from 'express';
import { authenticate, requireRole } from '../middleware/auth.js';
import { bad, AppError } from '../utils/errors.js';
import { tx } from '../db.js';
import { audit } from '../services/audit.js';
import { aiEnabled, AI_MODEL, askAssistant } from '../services/ai.js';

const r = Router();
r.use(authenticate);

// Small per-user throttle: 20 questions per rolling minute.
const hits = new Map();
function throttle(userId) {
  const now = Date.now();
  const recent = (hits.get(userId) || []).filter((t) => now - t < 60_000);
  if (recent.length >= 20) throw new AppError(429, 'You are asking questions very quickly. Please wait a moment and try again.');
  recent.push(now);
  hits.set(userId, recent);
}

r.get('/status', (req, res) => {
  res.json({ engine: aiEnabled() ? 'claude' : 'offline', model: aiEnabled() ? AI_MODEL : null });
});

r.post('/ask', requireRole('customer'), async (req, res, next) => {
  try {
    const { question, policyId, history } = req.body || {};
    const q = typeof question === 'string' ? question.trim() : '';
    if (q.length < 2 || q.length > 4000) throw bad('Ask a question between 2 and 4000 characters.');
    if (history !== undefined && !Array.isArray(history)) throw bad('history must be a list');
    throttle(req.user.id);
    const result = await askAssistant(req.user, { question: q, policyId: typeof policyId === 'string' && policyId ? policyId : undefined, history: history || [] });
    tx(() => audit(req.user, 'AI_QUESTION_ANSWERED', 'user', req.user.id, { mode: result.mode, citations: result.citations, abstained: result.abstained, urgent: result.urgent }));
    res.json(result);
  } catch (e) {
    next(e);
  }
});

export default r;
