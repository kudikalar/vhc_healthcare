// Partners module — Integration Hub administration: event log, deliveries, dead letters and
// integration exceptions (proposals stuck waiting for an insurer, failed event deliveries).
import { db, meta } from '../db.js';
import { now } from '../clock.js';
import { diffDays } from '../utils/dates.js';
import { eventStats, MAX_ATTEMPTS } from './events.js';
import { adapterCatalogue, ISSUANCE_MODES, OPERATIONS } from './insurerHub.js';
import { APP_STATUS as S } from './lifecycle.js';

export const STUCK_ISSUANCE_HOURS = 24;

export function hubOverview() {
  const insurers = db.all('insurers');
  return {
    stats: eventStats(),
    maxAttempts: MAX_ATTEMPTS,
    sandbox: { ...(meta().mockInsurer || { issuanceMode: 'auto' }), modes: ISSUANCE_MODES },
    operations: OPERATIONS,
    adapters: adapterCatalogue().map((a) => ({ ...a, insurers: insurers.filter((i) => i.integration?.adapter === a.key).map((i) => ({ id: i.id, name: i.name, status: i.status })) })),
    unconfigured: insurers.filter((i) => i.integration?.adapter && !adapterCatalogue().some((a) => a.key === i.integration.adapter)).map((i) => ({ id: i.id, name: i.name, adapter: i.integration.adapter, note: 'Adapter not deployed — built per signed agreement' })),
  };
}

const eventSummary = (e) => ({
  id: e.id, type: e.type, status: e.status, correlationId: e.correlationId, occurredAt: e.occurredAt, subject: e.subject, actor: e.actor,
  deliveries: e.deliveries.length, failedDeliveries: e.deliveries.filter((d) => ['retrying', 'dead_letter'].includes(d.status)).length,
});

export function listEvents({ type, status, correlationId, q, limit = 200 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  return db.find('events', (e) => (!type || e.type === type) && (!status || e.status === status)
    && (!correlationId || e.correlationId === correlationId) && (!q || JSON.stringify(e.payload).includes(q) || e.id === q))
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)).slice(0, lim).map(eventSummary);
}

export function eventDetail(e) {
  const related = db.find('events', (x) => x.correlationId === e.correlationId && x.id !== e.id).map(eventSummary);
  return { ...e, related };
}

/** Integration exceptions: dead-lettered deliveries and proposals waiting too long for an insurer decision. */
export function integrationExceptions() {
  const t = now();
  const stuck = db.find('applications', (a) => a.status === S.ISSUANCE_PENDING).map((a) => {
    const since = a.issuance?.requestedAt || a.timeline.findLast?.((x) => x.status === S.ISSUANCE_PENDING)?.at || a.updatedAt;
    const hours = Math.round((t - new Date(since)) / 3600000);
    const plan = db.get('plans', a.planId);
    return { kind: 'issuance_pending', id: a.id, reference: a.applicationNumber, insurerId: plan?.insurerId || null, insurerName: plan?.insurerName || null, since, hours, overdue: hours >= STUCK_ISSUANCE_HOURS, attempts: a.issuance?.attempts || 0, days: diffDays(since.slice(0, 10), t.toISOString().slice(0, 10)) };
  });
  const deadLetters = db.find('events', (e) => e.status === 'dead_letter' || e.status === 'retrying').map((e) => ({
    kind: e.status === 'dead_letter' ? 'dead_letter' : 'retrying', id: e.id, type: e.type, correlationId: e.correlationId, occurredAt: e.occurredAt,
    errors: e.deliveries.filter((d) => d.status !== 'delivered').map((d) => ({ handler: d.handler, status: d.status, attempts: d.attempts, lastError: d.lastError, nextAttemptAt: d.nextAttemptAt })),
  }));
  const exceptions = db.find('exceptions', (x) => x.type === 'event_dead_letter' && x.status === 'open');
  return { issuancePending: stuck, events: deadLetters, openExceptions: exceptions };
}
