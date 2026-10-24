# VHC Healthcare — Delivery Report (enterprise platform, phases 1–6)

Date: 16 Oct 2026 · Scope: audit of the existing app + build of phases 1–6 on top of it, as a modular monolith.

**Software readiness is reported separately from permission to do regulated insurance business.**
Everything runs in sandbox/test mode. The only active insurer, TPA and employer are synthetic and labelled
that way. Real insurers and hospital chains appear only as admin-side *candidates* ("no agreement").
No live insurance sale, live payment or real cashless claim is possible until the items in
[§9 Blockers](#9-blockers-partner--regulatory) are cleared.

## 1. Evidence

| Check | Result |
|---|---|
| Backend API tests (`cd backend && npm test`) | **80 / 80 pass** — the 28 original tests are unchanged and still pass. New tests: platform-core 5, partners 8, network 8, claims ops 9, corporate 10, enterprise 12 |
| Frontend production build (`cd frontend && npx vite build`) | Pass |
| Browser smoke test (Chromium, 1280px and 375px) | 12 QA accounts across 40 screens: no page errors, no horizontal overflow, no unexpected API failures |
| Existing data | Kept. A startup migration (`runStartupMigrations`) adds the new platform data in place: insurer links, organisations, QA accounts and network records. It never deletes or overwrites anything |

## 2. Audit of the existing application (before this work)

| Area | Status before | Note |
|---|---|---|
| Registration, email/mobile verification, sessions, CSRF, lockout | IMPLEMENTED | Kept as is |
| Health + term life catalogue, quotes, applications, underwriting | IMPLEMENTED | Products were VHC-branded, with no insurer or UIN → now linked to the sandbox insurer, with UINs |
| Test-card checkout | PARTIALLY IMPLEMENTED | Used generic test numbers, not the Razorpay ones → Razorpay test set added |
| Payment → policy | **BROKEN against the spec** | A successful payment issued the policy directly → now separate events (see §3) |
| Policies, renewals, life servicing, nominees | IMPLEMENTED | Kept; wallet extended |
| Cashless/reimbursement claims, payouts, life death claims | IMPLEMENTED | Kept; SLA, intimation, grievances and fraud review added |
| Hospitals | PARTIALLY IMPLEMENTED | A single `network` true/false flag → cashless is now recorded per insurer × hospital × product × date |
| Roles | PARTIALLY IMPLEMENTED | 6 roles → 21 roles with organisation scoping |
| Insurers, TPAs, corporate, finance ledgers, support desk, grievances, i18n | MISSING | Built (§4–§8) |

## 3. Platform core (shared)

| Feature | Status | UI route | Backend API | Entities | Roles | Security |
|---|---|---|---|---|---|---|
| Payment confirmation separate from issuance | VERIFIED | `/applications/:id` (status steps) | `services/insurerHub.js`, `/api/dev/mock-insurer`, insurer portal decisions | applications.issuance, events | customer, insurer_admin | Duplicate payment blocked while issuance pending; a repeated decision returns 409 |
| Insurer decline → automatic full refund | VERIFIED | `/payments`, `/finance/refunds` | `services/refunds.js` | refunds | finance_manager, admin | Original payment record never rewritten |
| Enterprise roles + organisation isolation | VERIFIED | Role home pages | `middleware/auth.js` (`requireOrg`, `assertSameOrg`) | users.orgId | all | Partner users only reach their own organisation's records; other tenants get 404 |
| Durable events (outbox, retries, dead letter, correlation IDs) | VERIFIED | `/partners/hub` | `services/events.js` | events | admin, operations_admin | Idempotency keys |
| Separate financial ledgers | VERIFIED | `/finance` | `services/ledger.js` | ledgerEntries | finance_manager | Premiums ≠ VHC revenue; ledgers record test/live mode |
| QA fixtures (spec usernames) | VERIFIED | `/login` | Sign-in accepts a username | users.qaFixture | — | Not created when `NODE_ENV=production` (unless `VHC_DEMO_ACCOUNTS=1`) |

## 4. Phase 1 — Marketplace & customer platform

| Feature | Status | UI route | Backend API | Note |
|---|---|---|---|---|
| Public landing with regulatory disclosure of VHC's role | IMPLEMENTED | `/` | `/api/enterprise/public/*`, `/api/partners/public/insurers` | No testimonials or statistics; IRDAI registration field is an admin-editable placeholder |
| Request callback / leads | VERIFIED | `/`, category pages | `POST /api/partners/leads` | Consent required, rate-limited |
| 14 configurable product categories | IMPLEMENTED | `/plans?category=` | `/api/partners/public/categories` | 11 categories honestly empty (no authorised products) |
| Comparison engine (all spec fields, UIN, CIS, wording) | IMPLEMENTED | `/plans` | `/api/plans/compare`, CIS/wording PDFs | Insurer documents override the UI summary |
| Quotes with reference, validity, versioned product | VERIFIED | `/quote` | `/api/quotes/*` | Source labelled "Sandbox insurer rating engine (synthetic)" |
| 13-step purchase journey & spec statuses | IMPLEMENTED | `/applications/:id` | `/api/applications/*` | CIS acknowledgement is enforced in the UI only |
| Policy wallet, e-card, CIS, claims contacts | IMPLEMENTED | `/policies` | `/api/policies/*` | Floater sum insured explained |
| Renewals + portability/migration | VERIFIED | `/portability`, `/insurer` | `/api/partners/portability*` | Only the receiving insurer decides |
| Razorpay test cards, UPI, QR, netbanking, payment links | VERIFIED | checkout, `/pay/:code` | `/api/payments/*` | Test mode only; `PAYMENT_MODE=live` refuses all simulators |
| Webhook HMAC signature + replay protection | VERIFIED | — | `/api/payments/callback` | Enforced when `PAYMENT_WEBHOOK_SECRET` is set |
| 25 payment scenarios catalogue with automated checks | IMPLEMENTED | `/admin/payment-scenarios` | `/api/enterprise/payment-scenarios` | Checks run in a rolled-back transaction |
| Receipts & GST invoices | IMPLEMENTED | `/payments` | `/:ref/receipt.pdf`, `/:ref/invoice.pdf` | GST rate configurable |
| Data rights (export, deletion request, consent) | IMPLEMENTED | `/profile` → Privacy, `/compliance/*` | `/api/enterprise/data-requests` | Deletion closes the login; policies, claims and payments are retained |
| Mobile OTP sign-in, Google SSO, passkeys | MISSING | — | — | Existing email + password and OTP verification kept; SSO needs a configured provider |

## 5. Phase 2 — Insurers, hospitals, TPAs

| Feature | Status | UI route | Note |
|---|---|---|---|
| Insurer registry + gated onboarding (Prospect → … → Active) | VERIFIED | `/partners/insurers` | Going Active requires live-sales approval, otherwise `BLOCKED_BY_REGULATORY_APPROVAL` |
| Integration hub (adapters, events, dead letters, sandbox mode) | IMPLEMENTED | `/partners/hub` | Only the sandbox adapter exists |
| Insurer partner portal + analytics | VERIFIED | `/insurer/*` | Issue/decline, products, portability; other insurers' records return 404 |
| Provider registry & credential verification | VERIFIED | `/network/providers` | NABH is shown only when verified, with its source |
| Provider contracts (maker–checker approval, amendments) | VERIFIED | `/network/contracts` | |
| Cashless network per insurer × hospital × product × date | VERIFIED | `/hospitals`, `/network/cashless` | Enforced on cashless claim filing and pre-auth |
| Hospital partner portal | VERIFIED | `/hospital` | Own hospital only; staff are read-only |
| TPA registry + portal | VERIFIED | `/tpa`, `/network/tpas` | TPAs can only recommend; claim decisions return 403 |
| Health services booking with payer disclosure | VERIFIED | `/services`, `/appointments` | Synthetic ₹49 booking fee, posted once to its ledger |

## 6. Phase 3 — Claims

| Feature | Status | UI route | Note |
|---|---|---|---|
| Claim intimation, enriched claim model, insurer claim reference | VERIFIED | `/claims/intimate`, `/claims/:id` | |
| Customer-facing statuses + responsible organisation + next action | VERIFIED | `/claims/:id` | |
| Versioned SLA policies (1 h pre-auth, 3 h final, 15 days settlement, grievances) + breach job | VERIFIED | `/ops/claims-sla` | Rules need confirmation by compliance |
| Grievances & appeals with Bima Bharosa / Ombudsman guidance | VERIFIED | `/grievances`, `/ops/grievances` | Kept distinct from support tickets |
| Fraud/anomaly flags → human review (never auto-deny) | VERIFIED | `/ops/fraud-review` | |
| Claims document intelligence (rule-based) | IMPLEMENTED | claim pages | Assists only; makes no decisions |

## 7. Phase 4 — Corporate

| Feature | Status | UI route | Note |
|---|---|---|---|
| Employer registry, onboarding, HR invites | VERIFIED | `/corporate/employers` | |
| Group quotes, contracts, group policy (synthetic group product) | IMPLEMENTED | `/corporate/policies` | |
| Roster CSV import, enrolment → insurer confirmation → certificate | VERIFIED | `/corporate/employees` | Follows the sandbox insurer modes |
| Endorsements with exact pro-rata adjustments | VERIFIED | `/corporate/endorsements` | Daily pro-rata is a sandbox assumption |
| HR dashboard (aggregates only, groups under 5 suppressed) | VERIFIED | `/corporate` | No employee medical data |
| Employee self-service | VERIFIED | `/benefits` | |
| Wellness, corporate billing, analytics | IMPLEMENTED | `/corporate/wellness`, `/corporate/invoices` | Premium → facilitated ledger; fee → VHC revenue |

## 8. Phases 5–6 — AI, analytics, enterprise

| Feature | Status | UI route | Note |
|---|---|---|---|
| AI policy assistant with sources, escalation, emergency guidance | IMPLEMENTED | Vision AI | Works without an API key (rule-based); no diagnosis |
| Sales: leads, pipeline, explainable lead score, funnel | IMPLEMENTED | `/sales` | No commission-based ranking |
| Retention intelligence | IMPLEMENTED | `/command` | |
| Super-admin command centre (KPI groups + 12 charts) | IMPLEMENTED | `/command` | Premiums, revenue and payouts shown separately |
| Finance: ledgers, insurer settlement, commission, reconciliation, refunds | VERIFIED | `/finance/*` | |
| Support desk + knowledge base | VERIFIED | `/helpdesk`, `/support/tickets`, `/support/kb` | |
| Compliance & audit views (audit log, access log, consent register) | IMPLEMENTED | `/compliance/*` | Auditors are read-only |
| English / Hindi / Telugu, larger-text mode | PARTIALLY IMPLEMENTED | top bar | Navigation and main pages are translated; deeper module pages are partly English |
| ABDM / ABHA / NHCX interoperability | BLOCKED BY REGULATORY APPROVAL | — | Needs official onboarding and certification; adapter boundary is ready |
| PostgreSQL, Redis/queues, object storage, WAF, observability | MISSING | — | Still runs on the JSON document store (see §10) |

## 9. Blockers (partner / regulatory)

| Item | Classification |
|---|---|
| Legal operating model (broker / web aggregator / corporate agent / technology partner) and IRDAI registration | BLOCKED BY REGULATORY APPROVAL |
| Real insurer agreements, product catalogues, UINs, rating APIs, issuance APIs | BLOCKED BY PARTNER |
| Live Razorpay account, live keys, settlement routing per licensed entity | BLOCKED BY REGULATORY APPROVAL / PARTNER |
| Hospital contracts, insurer network feeds, NABH/registry verification | BLOCKED BY PARTNER |
| TPA connectivity, NHCX, ABDM certification | BLOCKED BY PARTNER / REGULATORY APPROVAL |
| DPDP Act compliance review (phased commencement) | Needs qualified compliance review |

## 10. Production-readiness notes (engineering)

- **Storage:** data is still a single JSON document store, persisted to Redis on Vercel and saved last-writer-wins. Move to managed PostgreSQL before real traffic. The `db.js` interface is small, which makes the swap manageable.
- **Asynchronous work:** insurer callbacks and the event bus run in-process. Long-running insurer, claims and document work needs a worker and queue, not a serverless request (spec §48).
- **Webhooks:** set `PAYMENT_WEBHOOK_SECRET`.
- **Live mode:** keep `PAYMENT_MODE=test` everywhere except an approved production environment. Production must use `NODE_ENV=production`, which disables `/api/dev` and the QA fixtures.
- **Rollback:** every change is additive. Previous behaviour can be restored by redeploying the prior commit; the new collections are simply ignored by old code.
