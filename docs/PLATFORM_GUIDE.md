# VHC platform guide (for module developers)

Read this before changing code. The original app (health + term life insurance, claims, payments) is in
`backend/` (Express 5, JSON document store) and `frontend/` (React 19, React Router 7, plain CSS).
Read `README.md`, `backend/README.md` and `frontend/README.md` first.

## Ground rules from the product requirements

- Never remove or break existing functionality, accounts, policies or claims. All 33+ existing backend
  tests must keep passing (`cd backend && npm test`), and `cd frontend && npx vite build` must succeed.
- VHC is a technology platform/intermediary. Never present VHC as the insurer or regulator. Never
  present a real company (Star Health, HDFC ERGO, Apollo, Fortis, …) as a VHC partner. Real company names
  may appear only in the admin-only *candidate/prospect* pipeline, clearly labelled "candidate — no
  agreement". Everything active is **synthetic** and labelled as such (e.g. "VHC Sandbox Insurer
  (Synthetic)", the fictional hospitals in the seed, "Sandbox TPA Services (Synthetic)",
  "Northwind Demo Technologies").
- No invented "real" premiums, policy terms or statistics. Sandbox products are labelled sandbox.
- Payment confirmation and policy issuance are separate events (see `services/insurerHub.js`).
- Never store full card numbers, CVV or authentication credentials. Only documented gateway test cards.
- AI features never autonomously deny claims, diagnose, prescribe or issue final decisions; they flag for
  human review and show sources.
- Medical/financial details only to authorised roles; partner users only see their own organisation's
  records; HR/employers see aggregates, never identifiable employee medical information.

## Backend conventions

- Money is integer **paise**; percentages are **basis points**. Use `utils/money.js`.
- Every mutation runs inside `tx(() => …)` from `db.js` (synchronous, rolls back on throw).
- Collections are created on first use: `db.insert('anyName', rec)`, `db.find`, `db.findOne`, `db.get`,
  `db.touch(rec)`. Records get `id`, `createdAt`, `updatedAt`. Use `newId(prefix)`/`nextSeq(name)` for refs.
- Errors: throw `bad / unprocessable / forbidden / notFound / conflict` from `utils/errors.js`.
  Return 404 (not 403) for records that exist but belong to another tenant/customer.
- Time: always `now()` / `today()` from `clock.js` (the test clock can shift time).
- Audit every approval, rejection, financial action, partner status change and sensitive read:
  `audit(actor, 'ACTION', 'entityType', id, details)`; notify users with `notify(userId, title, msg, { link })`.
- Auth: `authenticate` (cookie session + CSRF), `requireRole(...roles)`, `requireOrg('insurer'|'hospital'|
  'tpa'|'employer')`, `assertSameOrg(user, orgId)` — all in `middleware/auth.js`. `req.user` has
  `{ id, role, name, email, orgType?, orgId?, orgName? }`.
- Roles (stored value → spec role): admin=SUPER_ADMIN, operations_admin, sales_manager, agent=SALES_EXECUTIVE,
  underwriter, claims_officer=CLAIMS_COORDINATOR, finance_manager, support_manager, support_agent,
  compliance_officer, auditor (read-only oversight), insurer_admin/insurer_user, hospital_admin/hospital_staff,
  tpa_admin/tpa_agent, corporate_admin/corporate_hr, customer, claimant.
  `READ_ONLY_ROLES` (auditor, compliance_officer) may read across modules but must never mutate.
- Organisations: insurers → `insurers`, hospitals → `hospitals` (existing collection; the hospital record
  *is* the organisation), TPAs → `tpas`, employers → `employers`. Partner users have `user.orgId`.
- Events: `publish(type, payload, { correlationId, idempotencyKey, actor, subject })` and
  `on(type, handlerName, fn)` in `services/events.js` (outbox with retries + dead letter). Handlers must
  validate before mutating.
- Ledgers: `post({ ledger, direction, amount, description, refType, refId, reference, insurerId, orgId,
  userId, correlationId, idempotencyKey })` in `services/ledger.js`. Premiums facilitated are not VHC
  revenue. Refunds: `services/refunds.js` (`createRefund`, `settleRefund`).
- Scheduled work: `registerJob(fn)` in `services/jobs.js` (fn runs inside the jobs transaction and returns
  counters to merge).
- Reference/demo data: your module's `services/<module>Seed.js` `ensure…Data(ctx)` runs after a fresh seed
  (`ctx.fresh`) and at start-up on existing databases. It must be idempotent: upsert by fixed ids, fill only
  missing fields, never delete. `ctx.demo` is false in production (do not create demo users/data then).
- Your API lives in `routes/<module>.js`, already mounted by `app.js` under `/api/<prefix>`:
  partners → `/api/partners`, network → `/api/network`, claimsOps → `/api/claims-ops`,
  corporate → `/api/corporate`, enterprise → `/api/enterprise`. Put logic in `services/<module>*.js`.
- Tests: node:test in `backend/tests/<module>.test.js` using `startServer()` from `tests/helpers.js`
  (fresh in-memory DB). `s.tokens` has sessions for every QA fixture: admin, agent, uw, claims, claims2,
  cust1 (Asha), cust2 (Rahul), superadmin, arjun, meera, neha (insurer_admin @ ins_sandbox), hospital
  (hospital_admin @ hsp_1), tpa (tpa_agent @ tpa_sandbox), sana (corporate_hr @ emp_demo), priya
  (claims_officer), finance, support, compliance, auditor, ops, sales.
  Helpers: `acceptedHealthApplication(s, token)`, `payApplication(s, token, app, outcome)`,
  `s.setInsurerMode('auto'|'manual'|'decline')`, `s.setClock({ advanceDays })`.

## QA fixtures (password `VisionDemo#2026`, sign in with username or `<username>@vhc.test`)

vhc_superadmin, customer_arjun, family_meera (family floater, 4 members), insurance_neha, hospital_rahul
(Sunrise Multispeciality Hospital, `hsp_1`), tpa_kiran, corporate_sana, claims_priya, finance_vikram,
support_ishaan, compliance_ananya, auditor_dev, ops_farah, sales_rohan. Original accounts
(customer@vhc.test, admin@vhc.test, …) still work.

## Frontend conventions

- Your pages live in `frontend/src/pages/<module>/`. `pages/<module>/index.jsx` exports `routes` and `nav`
  (see the comment in that file); `src/modules.js` merges them into `App.jsx` and the sidebar. Do not edit
  `App.jsx`, `Layout.jsx`, `modules.js`, `auth.jsx` or `styles.css` — put module CSS in
  `pages/<module>/<module>.css` and import it from your pages.
- Building blocks in `components/ui.jsx`: `useLoad`, `useAction`, `PageHeader`, `Card`, `Badge`, `Alert`,
  `ErrorBox`, `Field`, `Loading`, `Empty`, `Table`, `Modal`, `Timeline`, `Tabs`, `KV`, `Stat`, `DevHint`.
  `api` from `api.js` (`api.get/post/put/patch/delete/upload/download`), money/date formatting in
  `format.js` (`money(paise)`, `toPaise`, `date`, `dateTime`, `pct(bp)`, `titleCase`, `ROLE_LABEL`).
  Icons: `components/Icon.jsx` names (home, shield, claim, hospital, card, file, help, bell, user, calc,
  clipboard, work, alert, chart, settings, refresh, layers, payout, building, briefcase, ledger, ticket,
  globe, link, flag, clock, calendar, stethoscope, scale, family, explore, phone, chevron).
- Look at existing pages (e.g. `pages/staff/StaffOps.jsx`, `pages/customer/Dashboard.jsx`) and reuse
  the existing classes (`card`, `grid`, `stats`, `stat`, `row`, `stack`, `btn`, `btn secondary`, `btn sm`,
  `badge ok|warn|error|info`, `muted`, `table-wrap`, `kv`, `tabs`) so everything stays one design system.
  Every page must be responsive (works at 360px wide) and accessible (labels, headings, focus).
- Role home pages: insurer_* → `/insurer`, hospital_* → `/hospital`, tpa_* → `/tpa`, corporate_* →
  `/corporate`, finance_manager → `/finance`, support_* → `/helpdesk`, compliance_officer / auditor /
  operations_admin / sales_manager → `/command`, other staff → `/ops`, customer → `/dashboard`.
