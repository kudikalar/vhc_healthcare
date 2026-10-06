# Vision Health Care

Online health and life insurance platform: customers compare plans, get quotes, apply, pay, download policies and file claims; staff review applications, underwrite, assess claims and pay out.

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

New customers can self-register (email verification required before sign-in). Staff accounts are created by **invitation** from Users & roles.

Life claimants do **not** log in with an account: they use **Report a life claim**, verify the policy number + life assured name + DOB, then a one-time code (shown on screen in development).

## Tests

```bash
cd backend
npm test
```

28 API tests: 10 cover the identity modules VHC-M01…M05 (registration, verification, login/recovery/sessions, profile, dashboard acceptance checks) and 18 cover the priority scenarios from the specification: registration and verification expiry, cross-customer access, document size/content/authorisation, age-band and floater pricing, eligibility boundaries, the full underwriting → revised offer → payment → issuance flow, duplicate/failed/pending/wrong-amount payments, the ₹85,500 settlement, waiting periods, exclusions, cashless rules, concurrent floater claims, the ₹7,000 life quote, nominee rules and history, grace/lapse/reinstatement, and death claims with dual approval, idempotent payouts and report reconciliation.
