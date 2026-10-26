import express from 'express';
import cors from 'cors';
import { openapiSpec } from './openapi.js';
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
import aiRoutes from './routes/ai.js';
import familyRoutes from './routes/family.js';
import partnerRoutes from './routes/partners.js';
import networkRoutes from './routes/network.js';
import claimsOpsRoutes from './routes/claimsOps.js';
import corporateRoutes from './routes/corporate.js';
import enterpriseRoutes from './routes/enterprise.js';
import './services/insurerHub.js'; // registers integration event handlers
import { runStartupMigrations } from './services/seed.js';
import { storeStatus } from './services/remoteStore.js';

// Swagger UI is loaded from a CDN (pinned version) and reads the spec from /api/openapi.json. This
// keeps the docs page working on serverless hosts such as Vercel, where swagger-ui-express's bundled
// static assets are not traced into the function and would otherwise 404.
const SWAGGER_UI_VERSION = '5.17.14';
const SWAGGER_UI_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Vision Health Care API docs</title>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/${SWAGGER_UI_VERSION}/swagger-ui.min.css" />
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/${SWAGGER_UI_VERSION}/swagger-ui-bundle.min.js" crossorigin></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/${SWAGGER_UI_VERSION}/swagger-ui-standalone-preset.min.js" crossorigin></script>
  <script>
    window.onload = () => {
      window.ui = SwaggerUIBundle({
        url: '/api/openapi.json',
        dom_id: '#swagger-ui',
        deepLinking: true,
        presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
        layout: 'StandaloneLayout',
      });
    };
  </script>
</body>
</html>`;

export function createApp() {
  load();
  runStartupMigrations();
  const app = express();
  app.disable('x-powered-by');
  const origins = (process.env.CORS_ORIGIN || 'http://localhost:5173,http://localhost:5174').split(',');
  app.use(cors({ origin: origins, credentials: true }));
  // Keep the exact request bytes so payment webhook signatures are verified over what was received.
  app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
  // Authenticated data must never be served from a browser or proxy cache (e.g. after logout + Back).
  app.use('/api', (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

  app.get('/api/health', (req, res) => res.json({ ok: true, name: 'Vision Health Care API', time: now().toISOString(), store: storeStatus }));

  // API documentation: raw OpenAPI spec and interactive Swagger UI (served from a CDN, see above).
  app.get('/api/openapi.json', (req, res) => res.json(openapiSpec));
  app.get(['/api/docs', '/api/docs/'], (_req, res) => res.type('html').send(SWAGGER_UI_HTML));

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
  app.use('/api/ai', aiRoutes);
  app.use('/api/family', familyRoutes);
  // Enterprise platform modules
  app.use('/api/partners', partnerRoutes); // insurer registry, onboarding, integration hub, insurer portal
  app.use('/api/network', networkRoutes); // hospitals/providers, contracts, cashless networks, TPAs, bookings
  app.use('/api/claims-ops', claimsOpsRoutes); // claim SLAs, grievances, fraud review
  app.use('/api/corporate', corporateRoutes); // employers, group policies, enrolment, HR & employee portals
  app.use('/api/enterprise', enterpriseRoutes); // command centre, finance ledgers, refunds, support desk, i18n
  if (process.env.NODE_ENV !== 'production') app.use('/api/dev', devRoutes);

  app.use((req, res) => res.status(404).json({ error: 'Route not found' }));
  app.use(errorHandler);
  return app;
}
