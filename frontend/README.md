# Vision Health Care — Frontend

React 19 + React Router 7 single-page app built with Vite. Plain CSS (`src/styles.css`), no UI framework.

```bash
npm install
npm run dev        # http://localhost:5173 — /api is proxied to http://localhost:4000
npm run build      # production bundle in dist/
```

Start the backend first (see `../backend`). To call an API on another host, set `VITE_API_URL` (e.g. `https://api.example.com/api`) at build time, or `VITE_API_PROXY` for the dev proxy target.

## Screens

**Public:** two-column registration and sign-in (password visibility toggle, remember-device), email verification with resend countdown, password reset, staff invitation acceptance, home, plan catalogue & comparison, quote calculator (health and term life), network hospital search, registration, email verification, login, forgot/reset password, separate **Report a life claim** portal.

**Customer:** dashboard (product/date filters, four KPIs linked to filtered lists, policy cards with available cover, action queue, activity timeline, empty/loading/partial-error/retry states), profile with Personal / Address / Security tabs (completion checklist, verified email & mobile changes with OTP, preferences, password change, signed-in devices), applications (health members & declarations, life details & nominees, live quote, consent, submission, revised-offer acceptance, payment), policies (PDF download, frozen terms, floater balance, renewal, premium schedule, auto-pay, reinstatement, nominee changes with verification and history), health claims (cashless / reimbursement, documents, final bill), payments & receipts, notifications.

**Claimant:** verified, restricted portal to report and track a death claim and upload evidence.

**Staff:** operations dashboard, application queue, underwriting workspace (checklist, declarations, medical documents, requirements, decisions), reinstatement review, health claims workspace (pre-auth, bill review, assessment breakdown, approval), life claims workspace (status and nominees at date of death, beneficiaries, allocation, dual approval), payment & payout review, exception/retry queue.

**Admin:** plan & rate configuration (versioned JSON), hospital management, users & roles, notification broadcast/outbox, reports & audit logs, dev tools (test clock, auto-pay outcome, reset).

## Structure

```
src/
  api.js          fetch wrapper (HttpOnly session cookie + CSRF header, errors, downloads); money is integer paise
  auth.jsx        auth context
  format.js       ₹ formatting, exact rupee → paise parsing, dates
  components/     Layout, ui kit, editors (members, nominees), PayButton, DocumentPanel, QuoteBreakdown
  pages/          public/, customer/, claimant/, staff/, admin/
```
