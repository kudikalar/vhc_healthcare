import { Router } from 'express';
import { db, tx } from '../db.js';
import { authenticate } from '../middleware/auth.js';
import { notFound } from '../utils/errors.js';

const r = Router();
r.use(authenticate);

r.get('/', (req, res) => {
  const list = db.find('notifications', (n) => n.userId === req.user.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json({ unread: list.filter((n) => !n.read).length, notifications: list.slice(0, 100) });
});

r.post('/read-all', (req, res) => {
  tx(() => db.find('notifications', (n) => n.userId === req.user.id).forEach((n) => { n.read = true; }));
  res.json({ ok: true });
});

r.post('/:id/read', (req, res) => {
  const n = db.get('notifications', req.params.id);
  if (!n || n.userId !== req.user.id) throw notFound('Notification not found');
  tx(() => { n.read = true; });
  res.json(n);
});

export default r;
