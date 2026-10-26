import { Router } from 'express';
import { authenticate, requireRole } from '../middleware/auth.js';
import { bad, AppError, notFound } from '../utils/errors.js';
import { db, tx } from '../db.js';
import { audit } from '../services/audit.js';
import { aiEnabled, AI_MODEL, askAssistant, LANGUAGES } from '../services/ai.js';
import { createTicket } from '../services/enterpriseSupport.js';

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
  res.json({ engine: aiEnabled() ? 'claude' : 'offline', model: aiEnabled() ? AI_MODEL : null, languages: LANGUAGES });
});

r.post('/ask', requireRole('customer'), async (req, res, next) => {
  try {
    const { question, policyId, history, language } = req.body || {};
    const q = typeof question === 'string' ? question.trim() : '';
    if (q.length < 2 || q.length > 4000) throw bad('Ask a question between 2 and 4000 characters.');
    if (history !== undefined && !Array.isArray(history)) throw bad('history must be a list');
    throttle(req.user.id);
    const result = await askAssistant(req.user, { question: q, policyId: typeof policyId === 'string' && policyId ? policyId : undefined, history: history || [], language: typeof language === 'string' ? language : 'en' });
    const interaction = tx(() => {
      // Interaction log for evaluation: a short preview only, never the full conversation.
      const rec = db.insert('aiInteractions', {
        userId: req.user.id, questionPreview: q.slice(0, 200), language: result.language, mode: result.mode, citations: result.citations,
        abstained: !!result.abstained, urgent: !!result.urgent, refused: result.refused || null, escalationSuggested: !!result.escalation?.suggested,
        policyVersions: result.policyVersions || [],
      });
      audit(req.user, 'AI_QUESTION_ANSWERED', 'user', req.user.id, { interactionId: rec.id, mode: result.mode, citations: result.citations, abstained: result.abstained, urgent: result.urgent, language: result.language });
      return rec;
    });
    res.json({ ...result, interactionId: interaction.id });
  } catch (e) {
    next(e);
  }
});

const ownInteraction = (req, id) => {
  const it = id && db.get('aiInteractions', id);
  if (!it || it.userId !== req.user.id) throw notFound('Answer not found');
  return it;
};

/** Thumbs up/down evaluation of one answer (one rating per answer; a new rating replaces the old). */
r.post('/feedback', requireRole('customer'), (req, res) => {
  const { interactionId, rating, comment } = req.body || {};
  if (!['up', 'down'].includes(rating)) throw bad('rating must be up or down');
  const it = ownInteraction(req, interactionId);
  const ev = tx(() => {
    const existing = db.findOne('aiEvaluations', (e) => e.interactionId === it.id);
    const rec = existing || db.insert('aiEvaluations', { interactionId: it.id, userId: req.user.id });
    Object.assign(rec, { rating, comment: String(comment || '').trim().slice(0, 1000) || null, mode: it.mode, language: it.language, citations: it.citations, abstained: it.abstained, questionPreview: it.questionPreview });
    db.touch(rec);
    audit(req.user, 'AI_ANSWER_RATED', 'aiInteraction', it.id, { rating });
    return rec;
  });
  res.json(ev);
});

/** Hands a question to a person: creates a support ticket linked to the assistant answer. */
r.post('/escalate', requireRole('customer'), (req, res) => {
  const { interactionId, question, note } = req.body || {};
  const it = interactionId ? ownInteraction(req, interactionId) : null;
  const q = String(question || it?.questionPreview || '').trim();
  if (q.length < 2) throw bad('Tell us what you need help with.');
  const category = /claim|hospital|cashless|reimburse/i.test(q) ? 'claim_help' : /pay|refund|premium|receipt/i.test(q) ? 'payment' : 'policy';
  const ticket = tx(() => {
    const t = createTicket({
      user: req.user, category, subject: `Vision AI hand-off: ${q.slice(0, 100)}`, priority: 'normal', channel: 'ai_assistant', source: it ? `ai:${it.id}` : 'ai',
      message: `Question asked to Vision AI: ${q}${note ? `\n\nCustomer note: ${String(note).slice(0, 2000)}` : ''}${it?.citations?.length ? `\n\nSources cited by the assistant: ${it.citations.join(', ')}` : ''}`,
    });
    if (it) { it.escalatedTicketId = t.id; db.touch(it); }
    return t;
  });
  res.status(201).json({ ticket: { id: ticket.id, reference: ticket.reference, status: ticket.status } });
});

/** Evaluation summary for oversight (no customer identities). */
r.get('/evaluations', requireRole('admin', 'compliance_officer', 'auditor', 'support_manager'), (req, res) => {
  const evals = db.all('aiEvaluations');
  const interactions = db.all('aiInteractions');
  res.json({
    totals: {
      interactions: interactions.length, rated: evals.length, up: evals.filter((e) => e.rating === 'up').length, down: evals.filter((e) => e.rating === 'down').length,
      abstained: interactions.filter((i) => i.abstained).length, urgent: interactions.filter((i) => i.urgent).length, escalated: interactions.filter((i) => i.escalatedTicketId).length,
    },
    recent: evals.slice(-100).reverse().map(({ id, rating, comment, mode, language, citations, abstained, questionPreview, updatedAt }) => ({ id, rating, comment, mode, language, citations, abstained, questionPreview, at: updatedAt })),
  });
});

export default r;
