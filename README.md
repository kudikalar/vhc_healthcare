# Vision Health Care

Healthcare insurance and services platform: customers compare insurer products, get quotes, apply, pay, download policies, book health services and file claims. Insurers, hospitals, TPAs and employers work through their own partner portals. Internal teams run underwriting, claims, finance, support and compliance, and super admins have a command centre.

> **Staging / sandbox.** VHC is a technology platform. Insurance is issued only by the insurer named on each product. The only active insurer, TPA and employer are synthetic. No live sales or real payments are possible until the partner and regulatory items in [`docs/DELIVERY_REPORT.md`](docs/DELIVERY_REPORT.md) are cleared.

Docs: [`docs/DELIVERY_REPORT.md`](docs/DELIVERY_REPORT.md) (feature status, evidence, blockers) · [`docs/PLATFORM_GUIDE.md`](docs/PLATFORM_GUIDE.md) (architecture and conventions for developers).

## Platform modules

| Module | Backend | Frontend | What it covers |
|---|---|---|---|
| Core | `services/insurerHub.js`, `events.js`, `ledger.js`, `refunds.js`, `referenceData.js` | — | Payment separate from issuance, events and outbox, ledgers, refunds, roles/organisations, migrations |
| Partners | `/api/partners` | `pages/partners` | Insurer registry and onboarding, integration hub, insurer portal, categories/compare/CIS, portability, sales leads |
| Network | `/api/network` | `pages/network` | Providers, contracts, cashless networks per insurer/product, hospital and TPA portals, health-service bookings |
| Claims ops | `/api/claims-ops` | `pages/claimsops` | Intimation, unified statuses, regulatory SLA tracking, grievances and appeals, fraud review |
| Corporate | `/api/corporate` | `pages/corporate` | Employers, group policies, CSV roster, enrolment, endorsements, HR dashboard (aggregates only), employee benefits, billing |
| Enterprise | `/api/enterprise` | `pages/enterprise` | Razorpay sandbox, finance and reconciliation, command centre, support desk, compliance/data rights, landing page, EN/HI/TE |

Two independent projects:

| Folder | What | Stack | Port |
|---|---|---|---|
| [`backend/`](backend/README.md) | REST API | Node.js 20+, Express 5, JSON file store, cookie sessions + CSRF, Multer, PDFKit | 4000 |
| [`frontend/`](frontend/README.md) | Web app | React 19, React Router 7, Vite 7, plain CSS | 5173 |

## Quick start

```bash
cd backend
npm install
npm run reset     # fictional seed data (also happens automatically on first start)
npm start         # http://localhost:4000/api
```

```bash
cd frontend
npm install
npm run dev       # http://localhost:5173 (proxies /api to :4000)
```

If port 5173 is busy, Vite picks the next free port and prints it.

## Demo accounts (fictional)

Password for all: `VisionDemo#2026`

| Email | Role |
|---|---|
| customer@vhc.test | Customer (Asha Verma) — family floater + term life policies, one open claim |
| customer2@vhc.test | Customer (Rahul Mehta) — application waiting in underwriting |
| agent@vhc.test | Insurance agent |
| underwriter@vhc.test | Underwriter |
| claims@vhc.test, claims2@vhc.test | Claims officers (two are needed for life-claim dual approval) |
| admin@vhc.test | Administrator (includes Dev tools: test clock, reset) |

### Enterprise QA fixtures (synthetic; password `VisionDemo#2026`; sign in with the username)

| Username | Role | Organisation |
|---|---|---|
| vhc_superadmin | Super admin | — |
| customer_arjun | Customer (also an employee of Northwind, so sees `/benefits`) | — |
| family_meera | Family floater policyholder (4 members), open cashless claim | — |
| insurance_neha | Insurer partner admin | VHC Sandbox Insurer (Synthetic) |
| hospital_rahul | Hospital admin | Sunrise Multispeciality Hospital (fictional) |
| tpa_kiran | TPA agent | Sandbox TPA Services (Synthetic) |
| corporate_sana | Corporate HR | Northwind Demo Technologies (synthetic) |
| claims_priya | Claims coordinator | — |
| finance_vikram | Finance manager | — |
| support_ishaan | Support agent | — |
| compliance_ananya, auditor_dev, ops_farah, sales_rohan, corporate_kabir | Compliance, auditor, operations admin, sales manager, corporate admin | — |

These accounts are created only outside production (`NODE_ENV=production` skips them unless `VHC_DEMO_ACCOUNTS=1`). On an existing database they are added at start-up without changing other data. Use **Integration hub → sandbox issuance mode** (auto / manual / decline) to test what happens after a payment.

New customers can self-register (email verification required before sign-in). Staff accounts are created by **invitation** from Users & roles.

Life claimants do **not** log in with an account: they use **Report a life claim**, verify the policy number + life assured name + DOB, then a one-time code (shown on screen in development).

## Tests

```bash
cd backend
npm test
```

80 API tests (28 original + 52 for the platform modules). Of the original 28, 10 cover the identity modules VHC-M01…M05 (registration, verification, login/recovery/sessions, profile, dashboard acceptance checks) and 18 cover the priority scenarios from the specification: registration and verification expiry, cross-customer access, document size/content/authorisation, age-band and floater pricing, eligibility boundaries, the full underwriting → revised offer → payment → issuance flow, duplicate/failed/pending/wrong-amount payments, the ₹85,500 settlement, waiting periods, exclusions, cashless rules, concurrent floater claims, the ₹7,000 life quote, nominee rules and history, grace/lapse/reinstatement, and death claims with dual approval, idempotent payouts and report reconciliation.
