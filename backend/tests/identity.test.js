// Acceptance checks for VHC-M01 … VHC-M05 (registration, verification, sessions, profile, dashboard).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PASSWORD, sessionFrom, startServer } from './helpers.js';

let s;
before(async () => { s = await startServer(); });
after(() => s.close());

const NEUTRAL = 'If this address can be registered, check your email for next steps.';
const valid = (over = {}) => ({
  firstName: 'Priya', lastName: 'Sharma', email: 'Priya.Sharma@Example.test', mobile: '+91 98765 01234',
  password: 'correct horse battery', confirmPassword: 'correct horse battery', acceptTerms: true, ...over,
});
const register = (b) => s.api('POST', '/auth/register', { body: b });
// Each registration-adjacent test uses its own address so the per-destination send limits don't interfere.
let n = 0;
const fresh = () => `user${++n}@example.test`;

test('M01-AC01/AC02: one Pending Verification account + consent; repeats do not duplicate', async () => {
  const r1 = await register(valid());
  assert.equal(r1.status, 202);
  assert.equal(r1.body.message, NEUTRAL);
  const users = (await s.api('GET', '/admin/users?q=priya', { token: s.tokens.admin })).body;
  assert.equal(users.length, 1);
  assert.equal(users[0].status, 'Pending Verification');
  assert.equal(users[0].email, 'Priya.Sharma@Example.test', 'original display value preserved');
  assert.equal(users[0].mobile, '+919876501234', 'mobile normalised');
  assert.equal(users[0].role, 'customer');
  const r2 = await register(valid({ email: 'priya.sharma@example.test' })); // case-insensitive duplicate / retry
  assert.equal(r2.status, 202);
  assert.equal(r2.body.message, NEUTRAL);
  assert.equal(r2.body.devVerificationToken, undefined);
  assert.equal((await s.api('GET', '/admin/users?q=priya', { token: s.tokens.admin })).body.length, 1);
  const existing = await register(valid({ email: 'customer@vhc.test' }));
  assert.equal(existing.status, 202);
  assert.equal(existing.body.message, NEUTRAL, 'existing email gets the same neutral response');
});

test('M01-AC03: names, email, password lengths and confirmation', async () => {
  const f = async (over) => (await register(valid({ email: fresh(), ...over }))).body.details?.fields || {};
  assert.equal((await f({ firstName: '   ' })).firstName, 'Enter your first name.');
  assert.equal((await f({ firstName: 'R2D2' })).firstName, 'Enter your first name.');
  assert.equal((await register(valid({ email: fresh(), firstName: 'Zoë', lastName: "O'Brien-Núñez" }))).status, 202, 'Unicode names');
  assert.equal((await register(valid({ email: fresh(), firstName: 'Madhavan', lastName: '' }))).status, 202, 'one-name customer');
  assert.equal((await f({ lastName: 'Smith!' })).lastName, 'Use letters, spaces, apostrophes or hyphens.');
  assert.equal((await f({ email: 'not-an-email' })).email, 'Enter a valid email address.');
  assert.equal((await f({ mobile: '5123456789' })).mobile, 'Enter a valid 10-digit mobile number.');
  const pw = (p) => f({ password: p, confirmPassword: p });
  assert.ok((await pw('a'.repeat(5) + 'bcdef1')).password, '11 chars fails');
  assert.equal((await pw('abcdefghij12')).password, undefined, '12 chars passes');
  assert.equal((await pw('x'.repeat(127) + 'y')).password, undefined, '128 chars passes');
  assert.ok((await pw('x'.repeat(128) + 'y')).password, '129 chars fails');
  assert.ok((await pw('password1234')).password, 'compromised password fails');
  assert.equal((await pw('  spaces ok here  ')).password, undefined, 'spaces allowed, not trimmed');
  assert.equal((await f({ confirmPassword: 'different value!' })).confirmPassword, 'Passwords do not match.');
  assert.equal((await f({ acceptTerms: false })).acceptTerms, 'Accept the terms and acknowledge the privacy notice.');
});

test('M01-AC04: role injection creates no account', async () => {
  const email = fresh();
  const r = await register(valid({ email, role: 'admin' }));
  assert.equal(r.status, 400);
  assert.equal((await s.api('GET', `/admin/users?q=${email}`, { token: s.tokens.admin })).body.length, 0);
});

test('M02-AC01: verification link works once; replay and expiry fail', async () => {
  const email = fresh();
  const r = await register(valid({ email }));
  const token = r.body.devVerificationToken;
  assert.equal((await s.api('POST', '/auth/login', { body: { email, password: valid().password } })).status, 403, 'unverified cannot sign in');
  assert.equal((await s.api('POST', '/auth/verify-email', { body: { token } })).status, 200);
  assert.equal((await s.api('POST', '/auth/verify-email', { body: { token } })).status, 400, 'replay fails');
  const email2 = fresh();
  const t2 = (await register(valid({ email: email2 }))).body.devVerificationToken;
  await s.setClock({ advanceDays: 2 });
  const expired = await s.api('POST', '/auth/verify-email', { body: { token: t2 } });
  assert.equal(expired.body.error, 'This link has expired. Request a new one.');
  await s.setClock({ reset: true });
});

test('M02-AC01/AC03: mobile OTP single use, attempt limit, server-side resend cooldown', async () => {
  const t = s.tokens.cust2;
  const ch = await s.api('POST', '/profile/mobile-change', { token: t, body: { newMobile: '9811122233' } });
  assert.equal(ch.status, 201);
  assert.match(ch.body.destination, /^\+91 \*{6}2233$/, 'masked destination');
  const again = await s.api('POST', '/auth/mobile/send', { token: t });
  assert.equal(again.status, 429, 'resend within 60 s is refused by the server');
  for (let i = 0; i < 5; i++) assert.equal((await s.api('POST', '/auth/mobile/verify', { token: t, body: { challengeId: ch.body.challengeId, code: '000000' } })).status, 400);
  const locked = await s.api('POST', '/auth/mobile/verify', { token: t, body: { challengeId: ch.body.challengeId, code: ch.body.devCode } });
  assert.equal(locked.body.error, 'The code is invalid or has expired.', 'challenge dead after 5 failures');
});

test('M02-AC02: a code for the old destination cannot verify a changed destination', async () => {
  const t = s.tokens.cust1;
  const first = (await s.api('POST', '/profile/mobile-change', { token: t, body: { newMobile: '9700000001' } })).body;
  await s.setClock({ advanceDays: 1 }); // pass the resend cooldown
  const second = (await s.api('POST', '/profile/mobile-change', { token: t, body: { newMobile: '9700000002' } })).body;
  const old = await s.api('POST', '/auth/mobile/verify', { token: t, body: { challengeId: first.challengeId, code: first.devCode } });
  assert.equal(old.status, 400, 'superseded challenge for the old destination fails');
  const ok = await s.api('POST', '/auth/mobile/verify', { token: t, body: { challengeId: second.challengeId, code: second.devCode } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.mobile, '+919700000002');
  await s.setClock({ reset: true });
});

test('M03-AC01: wrong password and unknown email get the same message; lockout after 5 failures', async () => {
  const wrong = await s.api('POST', '/auth/login', { body: { email: 'agent@vhc.test', password: 'nope nope nope' } });
  const unknown = await s.api('POST', '/auth/login', { body: { email: 'ghost@vhc.test', password: 'nope nope nope' } });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.error, unknown.body.error);
  assert.equal(wrong.body.error, 'Email or password is incorrect.');
  for (let i = 0; i < 4; i++) await s.api('POST', '/auth/login', { body: { email: 'agent@vhc.test', password: 'nope nope nope' } });
  const locked = await s.api('POST', '/auth/login', { body: { email: 'agent@vhc.test', password: PASSWORD } });
  assert.equal(locked.status, 429, 'correct password is still refused while locked');
  // Verified reset recovers the account and clears the lock (throttles are not bypassed for others).
  const fp = await s.api('POST', '/auth/forgot-password', { body: { email: 'agent@vhc.test' } });
  assert.equal(fp.body.message, 'If an account exists, we have sent reset instructions.');
  const nobody = await s.api('POST', '/auth/forgot-password', { body: { email: 'ghost@vhc.test' } });
  assert.equal(nobody.body.message, fp.body.message);
  const reset = await s.api('POST', '/auth/reset-password', { body: { token: fp.body.devResetToken, password: 'a brand new passphrase', confirmPassword: 'a brand new passphrase' } });
  assert.equal(reset.status, 200);
  assert.equal((await s.api('GET', '/auth/me', { token: s.tokens.agent })).status, 401, 'reset revokes all sessions');
  assert.equal((await s.api('POST', '/auth/reset-password', { body: { token: fp.body.devResetToken, password: 'another passphrase!', confirmPassword: 'another passphrase!' } })).status, 400, 'reset token is single-use');
  s.tokens.agent = await s.login('agent@vhc.test', 'a brand new passphrase');
});

test('M03-AC02/AC03: sessions, CSRF, logout, staff "remember me" ignored, direct staff URLs', async () => {
  const sess = await s.login('customer2@vhc.test');
  assert.equal((await s.api('GET', '/auth/me', { token: sess })).status, 200);
  const noCsrf = await s.api('PUT', '/profile/preferences', { token: { ...sess, csrf: 'forged' }, body: { communicationPreference: 'email' } });
  assert.equal(noCsrf.status, 403, 'mutations without the CSRF token are refused');
  const other = await s.login('customer2@vhc.test'); // second tab/device
  await s.api('POST', '/auth/logout', { token: sess });
  assert.equal((await s.api('GET', '/dashboard', { token: sess })).status, 401, 'logged-out session cannot be reused');
  assert.equal((await s.api('GET', '/dashboard', { token: other })).status, 200, 'other session unaffected by logout');
  assert.equal((await s.api('GET', '/admin/users', { token: other })).status, 403, 'customer cannot open staff API');
  const res = await s.api('POST', '/auth/login', { body: { email: 'underwriter@vhc.test', password: PASSWORD, rememberDevice: true } });
  assert.equal(res.body.session.remembered, false, 'staff sessions never use remember-this-device');
  assert.ok(res.headers.getSetCookie().some((c) => c.startsWith('vhc_sid=') && c.includes('HttpOnly') && c.includes('SameSite=Strict')));
  const cust = await s.api('POST', '/auth/login', { body: { email: 'customer2@vhc.test', password: PASSWORD, rememberDevice: true } });
  assert.equal(cust.body.session.remembered, true);
  assert.equal((await s.api('GET', '/dashboard')).status, 401, 'no session → protected data refused');
  assert.equal((await s.api('GET', '/dashboard', { token: sessionFrom(cust) })).headers.get('cache-control'), 'no-store');
});

test('M03: disabled users cannot use or renew sessions', async () => {
  const sess = await s.login('customer2@vhc.test');
  await s.api('PATCH', '/admin/users/usr_cust2', { token: s.tokens.admin, body: { active: false } });
  assert.equal((await s.api('GET', '/auth/me', { token: sess })).status, 401);
  assert.equal((await s.api('POST', '/auth/login', { body: { email: 'customer2@vhc.test', password: PASSWORD } })).status, 403);
  await s.api('PATCH', '/admin/users/usr_cust2', { token: s.tokens.admin, body: { active: true } });
  s.tokens.cust2 = await s.login('customer2@vhc.test');
});

test('staff are invited, never self-registered; invitee sets their own password', async () => {
  const inv = await s.api('POST', '/admin/users', { token: s.tokens.admin, body: { firstName: 'Neha', lastName: 'Kapoor', email: 'neha@vhc.test', role: 'agent' } });
  assert.equal(inv.status, 201);
  assert.equal(inv.body.user.status, 'Invited');
  assert.equal((await s.api('POST', '/auth/login', { body: { email: 'neha@vhc.test', password: 'anything at all' } })).status, 401);
  assert.equal((await s.api('POST', '/auth/accept-invite', { body: { token: inv.body.devInviteToken, password: 'agent passphrase 1', confirmPassword: 'agent passphrase 1' } })).status, 200);
  assert.ok(await s.login('neha@vhc.test', 'agent passphrase 1'));
});

test('M04: profile validation, under-18 blocked at submission, pending email keeps current login', async () => {
  const t = s.tokens.cust1;
  const bad = await s.api('PUT', '/profile/address', { token: t, body: { line1: 'abc', city: 'C', state: 'Atlantis', postalCode: '12345' } });
  assert.equal(bad.status, 422);
  assert.deepEqual(Object.keys(bad.body.details.fields).sort(), ['city', 'line1', 'postalCode', 'state']);
  assert.equal((await s.api('PUT', '/profile/personal', { token: t, body: { legalName: 'Asha Verma', dob: '2099-01-01' } })).status, 422, 'future DOB');
  const ok = await s.api('PUT', '/profile/personal', { token: t, body: { legalName: 'Asha Verma', dob: '1988-04-12', gender: 'female' } });
  assert.ok(ok.body.profileVersion > 1, 'saves a new profile version');

  const ec = await s.api('POST', '/profile/email-change', { token: t, body: { newEmail: 'asha.new@example.test' } });
  assert.equal(ec.status, 202);
  assert.ok(await s.login('customer@vhc.test'), 'current email still signs in while change is pending');
  await s.api('POST', '/auth/verify-email', { body: { token: ec.body.devVerificationToken } });
  assert.ok(await s.login('asha.new@example.test'), 'new email signs in after verification');

  // Underage policyholder cannot submit an application.
  const young = await s.api('PUT', '/profile/personal', { token: s.tokens.cust2, body: { legalName: 'Rahul Mehta', dob: '2012-01-01' } });
  assert.equal(young.status, 200);
  const app = (await s.api('POST', '/applications', { token: s.tokens.cust2, body: { planId: 'pln_health_individual' } })).body;
  const sub = await s.api('POST', `/applications/${app.id}/submit`, { token: s.tokens.cust2 });
  assert.ok(sub.body.details.problems.includes('Policyholder must be at least 18.'));
  await s.api('PUT', '/profile/personal', { token: s.tokens.cust2, body: { legalName: 'Rahul Mehta', dob: '1979-11-02' } });
});

test('M04-AC03: other customers and unassigned agents cannot read a profile', async () => {
  assert.equal((await s.api('GET', '/profile/customers/usr_cust1', { token: s.tokens.cust2 })).status, 403);
  assert.equal((await s.api('GET', '/profile/customers/usr_cust1', { token: s.tokens.agent })).status, 403);
  const uw = await s.api('GET', '/profile/customers/usr_cust1', { token: s.tokens.uw });
  assert.equal(uw.status, 200);
  assert.match(uw.body.mobile, /\*{6}/, 'contacts masked for staff');
});

test('M05: KPIs reconcile with linked lists, filters validate, accounts are isolated', async () => {
  const t = s.tokens.cust1;
  const d = (await s.api('GET', '/dashboard', { token: t })).body;
  for (const [key, path] of [['activePolicies', '/policies?bucket=active'], ['pendingApplications', '/applications?bucket=pending'], ['openClaims', '/health-claims?bucket=open'], ['premiumsDue', '/policies?bucket=due']]) {
    const list = (await s.api('GET', path, { token: t })).body;
    assert.equal(d.kpis[key].count, list.length, `${key} reconciles with ${path}`);
  }
  assert.ok(d.policies.find((p) => p.product === 'health').availableCoverage > 0, 'per-policy health balance');
  assert.equal((await s.api('GET', '/dashboard?product=motor', { token: t })).body.error, 'Choose a valid product.');
  assert.equal((await s.api('GET', '/dashboard?from=2026-05-02&to=2026-05-01', { token: t })).body.error, 'End date must be on or after start.');
  const life = (await s.api('GET', '/dashboard?product=life', { token: t })).body;
  assert.ok(life.policies.every((p) => p.product === 'life'));
  // A brand new customer sees no policies (UI shows "Get a quote"), never someone else's data.
  const email = fresh();
  const tok = (await register(valid({ email }))).body.devVerificationToken;
  await s.api('POST', '/auth/verify-email', { body: { token: tok } });
  const fresh1 = await s.login(email, valid().password);
  const empty = (await s.api('GET', '/dashboard', { token: fresh1 })).body;
  assert.equal(empty.policies.length, 0);
  assert.equal(empty.kpis.activePolicies.count, 0);
  assert.ok(empty.actions.some((a) => a.kind === 'profile'));
});
