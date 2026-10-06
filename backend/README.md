# Vision Health Care — Backend (REST API)

Node.js + Express 5 REST API for health and term life insurance.

```bash
npm install
npm start          # http://localhost:4000/api — seeds automatically if the database is empty
npm run dev        # with auto-reload
npm run reset      # development only: wipe data + uploaded files, reload fictional seed data
npm test           # API test suite (in-memory database)
```

Environment variables (see `.env.example`): `PORT` (4000), `CORS_ORIGIN` (comma-separated, credentials enabled), `NODE_ENV`, `SESSION_IDLE_MS` (optional override). With `NODE_ENV=production` the `/api/dev` routes are not mounted and dev tokens/OTPs are not returned in responses.

## Identity & sessions (VHC-M01 … M05)

- **Registration** (`POST /auth/register`): first/last name (Unicode, one-name customers allowed), email (case-insensitive unique, display value preserved), India mobile normalised to `+91XXXXXXXXXX`, 12–128 character password checked against a compromised list, terms/privacy consent stored with version + timestamp, optional revocable marketing consent. Always creates a **Customer** in *Pending Verification*; privileged fields (`role`, `isAdmin`, …) are rejected. Existing emails get the same neutral response.
- **Verification challenges** (`services/challenges.js`): random tokens/OTPs stored hashed, single-use, bound to account + purpose + destination, superseded by newer challenges; email links 24 h, OTPs 5 min with 5 attempts; resend cooldown 60 s and max 5 sends per destination per hour (enforced server-side).
- **Sessions** (`services/security.js`): server-side sessions in an HttpOnly `SameSite=Strict` cookie (`Secure` in production), rotated on login; CSRF token required in `X-CSRF-Token` for every state-changing authenticated request. Idle timeout 30 min, absolute 12 h; "remember this device" gives 7 days for customers only. Logout revokes the session; password reset/change revokes all others; disabled users and role changes end sessions. 5 failed sign-ins in 15 min lock the email for 15 min (plus IP throttling); the error is identical for unknown email and wrong password. All API responses are `Cache-Control: no-store`.
- **Staff** join by invitation (`POST /admin/users` → `POST /auth/accept-invite`).
- **Profile** (`/profile/personal|address|preferences|email-change|mobile-change`): versioned snapshots, 6-digit postal codes and configured state list, contact changes take effect only after the new destination is verified. Applications cannot be submitted until legal name, DOB (18+) and address are complete; reimbursement payouts need a verified mobile.
- **Dashboard** (`GET /dashboard?product=&from=&to=`): KPIs computed from the same bucket filters as `/policies?bucket=active|due`, `/applications?bucket=pending`, `/health-claims?bucket=open`, so counts always reconcile; per-policy available health cover; action queue; customer-visible activity; partial-section errors reported in `partialErrors`.

## Design notes

- **Money** is always an integer number of **paise** (₹1 = 100). Percentages are **basis points** (10000 = 100%). No floating-point currency arithmetic.
- **Storage** is a JSON document store (`data/db.json`). Every mutation runs inside `tx()`, which is synchronous (atomic in Node's single thread), persists on success and rolls back the whole state on error. This gives transactional benefit-balance updates. Swap `src/db.js` for a real database before production.
- **Documents** are stored in `storage/private/`, never served statically. Downloads go through an authorised endpoint and are audited; content is validated by magic bytes (PDF/PNG/JPEG only, 5 MB max).
- **Test clock**: all business logic reads time through `src/clock.js`. Admins can shift it (`POST /api/dev/clock`) to test quote expiry, waiting periods, grace periods, lapse and renewals. Moving the clock runs scheduled jobs (reminders, auto-pay).
- **Plan versions**: editing a plan creates a new version. Each policy stores a frozen `termsSnapshot`, so later edits never change existing coverage.
- **Idempotency**: payments use unique references plus client idempotency keys; gateway and payout callbacks are ignored once a final state has been applied. Claims and application submission are also safe to retry.
- **Audit log**: approvals, rejections, financial actions, nominee changes and every document download are recorded.

## Layout

```
src/
  app.js, server.js, db.js, clock.js
  middleware/auth.js         cookie-session auth, CSRF, roles
  services/
    pricing.js               health & life quote engines (server-side, authoritative)
    lifecycle.js             application workflow, policy issuance, policy status, nominees
    settlement.js            health claim assessment (waiting periods, exclusions, deductible, co-pay, limits)
    payments.js              simulated gateway + payout rail (idempotent)
    access.js                authorisation rules
    jobs.js                  reminders, grace/lapse notices, auto-pay
    pdf.js, audit.js, seed.js
  routes/                    one router per resource (see below)
tests/                       node:test API tests
```

## API overview (all under `/api`)

| Area | Endpoints |
|---|---|
| Auth | `POST /auth/register`, `/auth/verify-email`, `/auth/resend-verification`, `/auth/mobile/send`, `/auth/mobile/verify`, `/auth/login`, `/auth/logout`, `GET /auth/me`, `GET /auth/sessions`, `POST /auth/sessions/:id/revoke`, `/auth/change-password`, `/auth/forgot-password`, `GET /auth/reset-password/check`, `POST /auth/reset-password`, `GET /auth/invite/check`, `POST /auth/accept-invite` |
| Profile | `GET /profile`, `PUT /profile/personal`, `/profile/address`, `/profile/preferences`, `POST /profile/email-change`, `/profile/mobile-change`, `/profile/cancel-contact-change`, `GET /profile/customers/:id` (assigned staff) |
| Dashboard | `GET /dashboard?product=all\|health\|life&from=&to=` |
| Plans | `GET /plans?product=&type=`, `GET /plans/:id`, `GET /plans/compare?ids=` |
| Quotes | `POST /quotes/health`, `POST /quotes/life` |
| Applications | `GET/POST /applications`, `GET/PUT /applications/:id`, `POST /:id/quote`, `/:id/submit`, `/:id/accept-offer`, `/:id/decline-offer`, `/:id/reopen`, `/:id/validate-nominees` |
| Review & underwriting | `POST /applications/:id/review/start`, `/review/request-correction`, `/review/forward`, `/notes`, `/underwriting/requirements`, `/underwriting/requirements/:rid`, `/underwriting/decision` |
| Payments | `POST /payments/initiate`, `/payments/:ref/simulate`, `/payments/callback` (gateway webhook), `GET /payments` |
| Policies | `GET /policies`, `GET /policies/:id`, `GET /:id/pdf`, `POST /:id/autopay`, `/:id/nominees`, `/:id/nominees/verify`, `GET /:id/nominees/at?date=`, `POST /:id/reinstatement`, `/:id/renew` |
| Reinstatements | `GET /reinstatements`, `POST /reinstatements/:id/decision` |
| Hospitals | `GET /hospitals?q=&city=&postalCode=&specialty=&network=`, admin `POST/PUT /hospitals` |
| Health claims | `GET/POST /health-claims`, `GET /:id`, `POST /:id/preauth`, `/final-bill`, `/assess`, `/approve`, `/reject`, `/request-documents`, `/respond`, `/verify-payout`, `/notes` |
| Life claims | `POST /life-claims/portal/start`, `/portal/verify`, `GET /portal/me`; `GET/POST /life-claims`, `POST /:id/start-review`, `/request-documents`, `/respond`, `/verify-claimant`, `/clear-flag`, `PUT /:id/beneficiaries`, `POST /:id/assess`, `/second-approval`, `/send-back`, `/reject`, `/notes` |
| Payouts | `GET /payouts`, `POST /payouts/initiate`, `/payouts/:ref/simulate`, `/payouts/callback` |
| Documents | `POST /documents` (multipart), `GET /documents?entityType=&entityId=`, `GET /documents/:id/download` |
| Notifications | `GET /notifications`, `POST /notifications/:id/read`, `/read-all` |
| Admin | `/admin/users`, `/admin/plans`, `/admin/plans/:id/status`, `/admin/notifications`, `/admin/notifications/broadcast`, `/admin/audit-logs`, `/admin/exceptions`, `/admin/exceptions/:id/retry`, `/resolve` |
| Reports | `GET /reports/summary` (queues, status breakdowns, reconciliation) |
| Dev (non-production) | `GET/POST /dev/clock`, `POST /dev/reset`, `/dev/run-jobs`, `/dev/autopay-outcome` |

## Key business rules implemented

- Health pricing: age-band premium per member → coverage multiplier (₹5L ×1.0, ₹10L ×1.8) → 10% floater discount → optional benefits added after discount. Ages are calculated at the coverage start date; above 65 is ineligible on the sample plans (the senior plan has its own table).
- Life pricing: `(sum assured ÷ ₹1,000) × rate + riders`; rates vary by age band, tobacco, term and underwriting class; monthly uses a configured modal factor (8.8%), not ÷12. Missing rate combinations are rejected.
- Workflow: Draft → Submitted → Initial Review → Underwriting → Approved / Rejected / More Information Required (/ Postponed for life). Resubmission returns to where it was paused. Payment only after the customer accepts the (possibly revised) offer.
- Health claims: member must be on the policy; coverage judged on the admission date (claims can be reviewed after expiry); initial and condition waiting periods, exclusions, room-rent cap, deductible and co-pay; approval reserves funds against the (shared, for floaters) balance; payout moves reserved → paid exactly once.
- Life servicing: payment schedule, grace period by frequency, lapse, reinstatement (underwriter-approved, then arrears payment), auto-pay simulation with failures sent to the exception queue.
- Death claims: restricted claimant accounts, future dates rejected, duplicates flagged (not paid), policy status/nominees evaluated at the date of death, allocations must equal the approved total, independent second approval, idempotent payouts, policy terminated only after full settlement.

The optional endowment/maturity phase is not implemented; the term plan explicitly has no maturity benefit.
