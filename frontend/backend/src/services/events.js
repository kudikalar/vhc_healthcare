// Durable domain events (outbox pattern on the document store).
//
// publish() records the event inside the caller's transaction, then delivers it to every registered
// handler. Each delivery is tracked separately with attempts, last error and next retry time. Failed
// deliveries are retried by retryPendingEvents() (run from scheduled jobs) and move to dead_letter after
// MAX_ATTEMPTS, which also raises an operations exception. Events carry a correlation id so a payment,
// its insurer issuance and the resulting ledger postings can be traced together. Publishing the same
// idempotencyKey twice returns the original event and does not run handlers again.
//
// Handlers must validate before they mutate: a handler that throws after changing records leaves those
// changes in place (the surrounding transaction is not rolled back for a handler failure).
import crypto from 'node:crypto';
import { db } from '../db.js';
import { now } from '../clock.js';
import { raiseException } from './audit.js';

export const EVENT_TYPES = [
  'USER_REGISTERED', 'QUOTE_CREATED', 'PROPOSAL_SUBMITTED', 'UNDERWRITING_UPDATED', 'PAYMENT_CAPTURED', 'PAYMENT_FAILED',
  'POLICY_ISSUANCE_REQUESTED', 'POLICY_ISSUED', 'POLICY_DECLINED', 'REFUND_CREATED', 'REFUND_COMPLETED', 'RENEWAL_DUE', 'POLICY_RENEWED',
  'CLAIM_INTIMATED', 'PREAUTH_REQUESTED', 'PREAUTH_DECIDED', 'CLAIM_SETTLED', 'HOSPITAL_CONTRACT_ACTIVATED',
  'CORPORATE_MEMBER_ENROLLED', 'SUPPORT_TICKET_CREATED', 'GRIEVANCE_CREATED', 'INSURER_STATUS_CHANGED',
];
export const MAX_ATTEMPTS = 5;
const BACKOFF_MS = [0, 60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];

const handlers = new Map(); // type -> Map(name -> fn)

/** Registers a named handler. Re-registering the same name replaces it (safe under hot reload). */
export function on(type, name, fn) {
  if (!handlers.has(type)) handlers.set(type, new Map());
  handlers.get(type).set(name, fn);
}

export const newCorrelationId = () => `cor_${crypto.randomBytes(8).toString('hex')}`;

function deliver(event, delivery) {
  const fn = handlers.get(event.type)?.get(delivery.handler);
  delivery.attempts += 1;
  delivery.lastAttemptAt = now().toISOString();
  if (!fn) {
    delivery.status = 'skipped';
    delivery.lastError = 'No handler registered';
    return;
  }
  try {
    const result = fn(event.payload, event);
    delivery.status = 'delivered';
    delivery.lastError = null;
    delivery.result = result ?? null;
  } catch (e) {
    delivery.lastError = e.message;
    if (delivery.attempts >= MAX_ATTEMPTS) {
      delivery.status = 'dead_letter';
      raiseException('event_dead_letter', event.id, `${event.type} → ${delivery.handler}: ${e.message}`, { correlationId: event.correlationId });
    } else {
      delivery.status = 'retrying';
      delivery.nextAttemptAt = new Date(now().getTime() + BACKOFF_MS[delivery.attempts] ).toISOString();
    }
  }
}

function rollup(event) {
  const s = event.deliveries.map((d) => d.status);
  event.status = s.includes('dead_letter') ? 'dead_letter' : s.includes('retrying') ? 'retrying' : 'processed';
  db.touch(event);
}

/**
 * Records and delivers an event. Returns { event, duplicate }.
 * opts: { correlationId, idempotencyKey, actor, subject: { type, id } }
 */
export function publish(type, payload = {}, opts = {}) {
  if (opts.idempotencyKey) {
    const existing = db.findOne('events', (e) => e.idempotencyKey === opts.idempotencyKey);
    if (existing) return { event: existing, duplicate: true };
  }
  const names = [...(handlers.get(type)?.keys() || [])];
  const event = db.insert('events', {
    type, payload, correlationId: opts.correlationId || newCorrelationId(), idempotencyKey: opts.idempotencyKey || null,
    subject: opts.subject || null, actor: opts.actor ? { id: opts.actor.id || null, role: opts.actor.role || 'system', name: opts.actor.name || 'System' } : null,
    occurredAt: now().toISOString(), status: 'pending',
    deliveries: names.map((handler) => ({ handler, status: 'pending', attempts: 0, lastError: null, nextAttemptAt: null })),
  });
  for (const d of event.deliveries) deliver(event, d);
  rollup(event);
  return { event, duplicate: false };
}

/** Retries deliveries whose backoff has elapsed (or all retrying ones when force). */
export function retryPendingEvents({ force = false, eventId } = {}) {
  const t = now().toISOString();
  let retried = 0;
  for (const event of db.find('events', (e) => (eventId ? e.id === eventId : ['retrying', 'pending'].includes(e.status)))) {
    for (const d of event.deliveries) {
      const due = d.status === 'retrying' && (force || !d.nextAttemptAt || d.nextAttemptAt <= t);
      const replayDead = eventId && d.status === 'dead_letter';
      if (due || replayDead || d.status === 'pending') {
        if (replayDead) d.attempts = MAX_ATTEMPTS - 1; // one more manual attempt
        deliver(event, d);
        retried += 1;
      }
    }
    rollup(event);
  }
  return { retried };
}

export function eventStats() {
  const all = db.all('events');
  const by = (f) => all.reduce((m, e) => ({ ...m, [f(e)]: (m[f(e)] || 0) + 1 }), {});
  return { total: all.length, byStatus: by((e) => e.status), byType: by((e) => e.type) };
}
