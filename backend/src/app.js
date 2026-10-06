import express from 'express';
import cors from 'cors';
import { load } from './db.js';
import { now } from './clock.js';
import { errorHandler } from './utils/errors.js';
import authRoutes from './routes/auth.js';
import profileRoutes from './routes/profile.js';
import planRoutes from './routes/plans.js';
import quoteRoutes from './routes/quotes.js';
import applicationRoutes from './routes/applications.js';
import paymentRoutes from './routes/payments.js';
import policyRoutes, { reinstatementRouter } from './routes/policies.js';
import hospitalRoutes from './routes/hospitals.js';
import healthClaimRoutes from './routes/healthClaims.js';
import lifeClaimRoutes from './routes/lifeClaims.js';
import payoutRoutes from './routes/payouts.js';
import documentRoutes from './routes/documents.js';
import notificationRoutes from './routes/notifications.js';
import adminRoutes from './routes/admin.js';
import reportRoutes from './routes/reports.js';
import devRoutes from './routes/dev.js';
import dashboardRoutes from './routes/dashboard.js';

export function createApp() {
  load();
  const app = express();
  app.disable('x-powered-by');
  const origins = (process.env.CORS_ORIGIN || 'http://localhost:5173,http://localhost:5174').split(',');
  app.use(cors({ origin: origins, credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  // Authenticated data must never be served from a browser or proxy cache (e.g. after logout + Back).
  app.use('/api', (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

  app.get('/api/health', (req, res) => res.json({ ok: true, name: 'Vision Health Care API', time: now().toISOString() }));
  app.use('/api/auth', authRoutes);
  app.use('/api/profile', profileRoutes);
  app.use('/api/dashboard', dashboardRoutes);
  app.use('/api/plans', planRoutes);
  app.use('/api/quotes', quoteRoutes);
  app.use('/api/applications', applicationRoutes);
  app.use('/api/payments', paymentRoutes);
  app.use('/api/policies', policyRoutes);
  app.use('/api/reinstatements', reinstatementRouter);
  app.use('/api/hospitals', hospitalRoutes);
  app.use('/api/health-claims', healthClaimRoutes);
  app.use('/api/life-claims', lifeClaimRoutes);
  app.use('/api/payouts', payoutRoutes);
  app.use('/api/documents', documentRoutes);
  app.use('/api/notifications', notificationRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/reports', reportRoutes);
  if (process.env.NODE_ENV !== 'production') app.use('/api/dev', devRoutes);

  app.use((req, res) => res.status(404).json({ error: 'Route not found' }));
  app.use(errorHandler);
  return app;
}
