import { db } from '../db.js';
import { now } from '../clock.js';

const QUIET = process.env.DB_IN_MEMORY === '1';

/** Every approval, rejection, financial action and sensitive document access is recorded here. */
export function audit(actor, action, entityType, entityId, details = {}) {
  db.insert('auditLogs', {
    actorId: actor?.id || 'system',
    actorRole: actor?.role || 'system',
    actorName: actor?.name || 'System',
    action, entityType, entityId, details,
    at: now().toISOString(),
  });
}

/** In-app notification; email delivery is simulated (logged to console). */
export function notify(userId, title, message, { type = 'info', dedupeKey, link } = {}) {
  if (!userId) return null;
  if (dedupeKey && db.findOne('notifications', (n) => n.dedupeKey === dedupeKey)) return null;
  if (!QUIET) console.log(`[email:simulated] to=${userId} :: ${title}`);
  return db.insert('notifications', {
    userId, title, message, type, link, dedupeKey, read: false, channel: 'in-app + email (simulated)',
  });
}

export function raiseException(type, refId, error, data = {}) {
  return db.insert('exceptions', { type, refId, error, data, status: 'open', attempts: 0, history: [] });
}
