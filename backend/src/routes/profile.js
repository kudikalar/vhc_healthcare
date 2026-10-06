// VHC-M04 customer profile, address, contact changes and preferences.
import { Router } from 'express';
import { db, tx } from '../db.js';
import { now, today } from '../clock.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { forbidden, notFound, unprocessable } from '../utils/errors.js';
import { isValidDate } from '../utils/dates.js';
import { cleanEmail, cleanName, maskEmail, maskMobile, normalizeMobile } from '../services/security.js';
import { challengeView, createChallenge } from '../services/challenges.js';
import { publicUser, snapshotProfile, STATES } from '../services/profile.js';
import { audit } from '../services/audit.js';

const r = Router();
const DEV = process.env.NODE_ENV !== 'production';
r.use(authenticate);

const me = (req) => {
  const u = db.get('users', req.user.id);
  if (!u) throw notFound();
  return u;
};
const fail = (fields) => { if (Object.keys(fields).length) throw unprocessable('Please correct the highlighted fields.', { fields }); };

r.get('/', requireRole('customer', 'agent', 'underwriter', 'claims_officer', 'admin'), (req, res) => {
  res.json({ ...publicUser(me(req)), states: STATES });
});

r.put('/personal', requireRole('customer', 'agent', 'underwriter', 'claims_officer', 'admin'), (req, res) => {
  const u = me(req);
  const b = req.body || {};
  const fields = {};
  const legalName = cleanName(b.legalName, { max: 120 });
  if (!legalName) fields.legalName = 'Enter your legal name.';
  if (b.dob && (!isValidDate(b.dob) || b.dob >= today())) fields.dob = 'Enter a real date of birth in the past.';
  if (b.gender && !['female', 'male', 'other', 'undisclosed'].includes(b.gender)) fields.gender = 'Select a valid option.';
  fail(fields);
  tx(() => {
    snapshotProfile(u, req.user, 'personal');
    u.legalName = legalName;
    u.profile = { ...u.profile, dob: b.dob || '', gender: b.gender || '' };
    audit(req.user, 'PROFILE_UPDATED', 'user', u.id, { section: 'personal', version: u.profileVersion });
  });
  res.json(publicUser(u));
});

r.put('/address', requireRole('customer', 'agent', 'underwriter', 'claims_officer', 'admin'), (req, res) => {
  const u = me(req);
  const b = req.body || {};
  const s = (v) => String(v ?? '').trim();
  const fields = {};
  const line1 = s(b.line1), line2 = s(b.line2), city = s(b.city), state = s(b.state), postalCode = s(b.postalCode);
  if (line1.length < 5 || line1.length > 150) fields.line1 = 'Enter your house/building and street.';
  if (line2.length > 150) fields.line2 = 'Keep address within 150 characters.';
  if (city.length < 2 || city.length > 80 || !STATES.includes(state)) {
    if (city.length < 2 || city.length > 80) fields.city = 'Select your city and state.';
    if (!STATES.includes(state)) fields.state = 'Select your city and state.';
  }
  if (!/^\d{6}$/.test(postalCode)) fields.postalCode = 'Enter a 6-digit postal code.';
  fail(fields);
  tx(() => {
    snapshotProfile(u, req.user, 'address');
    u.profile = { ...u.profile, address: { line1, line2, city, state, postalCode, country: 'India' } };
    audit(req.user, 'PROFILE_UPDATED', 'user', u.id, { section: 'address', version: u.profileVersion });
  });
  res.json(publicUser(u));
});

r.put('/preferences', requireRole('customer', 'agent', 'underwriter', 'claims_officer', 'admin'), (req, res) => {
  const u = me(req);
  const { communicationPreference, marketingOptIn } = req.body || {};
  if (!['email', 'email_sms'].includes(communicationPreference)) fail({ communicationPreference: 'Select a valid preference.' });
  if (communicationPreference === 'email_sms' && !u.mobileVerified) fail({ communicationPreference: 'Verify your mobile number to receive SMS.' });
  tx(() => {
    snapshotProfile(u, req.user, 'preferences');
    u.communicationPreference = communicationPreference;
    if (typeof marketingOptIn === 'boolean' && marketingOptIn !== !!u.marketingOptIn) {
      u.marketingOptIn = marketingOptIn; // independently revocable; service notices are unaffected
      db.insert('consents', { userId: u.id, type: 'marketing', granted: marketingOptIn, at: now().toISOString(), ip: req.ip });
    }
    audit(req.user, 'PREFERENCES_UPDATED', 'user', u.id, { communicationPreference, marketingOptIn: u.marketingOptIn });
  });
  res.json(publicUser(u));
});

/** Email change: the current email keeps working until the new one is verified. */
r.post('/email-change', (req, res) => {
  const u = me(req);
  const email = cleanEmail(req.body?.newEmail);
  if (!email) fail({ newEmail: 'Enter a valid email address.' });
  if (email.toLowerCase() === u.emailLower) fail({ newEmail: 'This is already your email address.' });
  let token = null;
  tx(() => {
    const taken = db.findOne('users', (x) => x.emailLower === email.toLowerCase());
    if (!taken) {
      u.pendingEmail = email;
      token = createChallenge({ subjectId: u.id, purpose: 'email_change', destination: email.toLowerCase(), kind: 'link' }).secret;
      audit(req.user, 'EMAIL_CHANGE_REQUESTED', 'user', u.id, { to: maskEmail(email) });
    }
  });
  res.status(202).json({
    message: 'Verify the new contact before saving. If this address can be used, we sent a verification link to it.',
    destination: maskEmail(email), ...(DEV && token ? { devVerificationToken: token } : {}),
  });
});

r.post('/mobile-change', (req, res) => {
  const u = me(req);
  const mobile = normalizeMobile(req.body?.newMobile);
  if (!mobile) fail({ newMobile: 'Enter a valid 10-digit mobile number.' });
  if (mobile === u.mobile && u.mobileVerified) fail({ newMobile: 'This is already your verified mobile number.' });
  const { challenge, secret } = tx(() => {
    u.pendingMobile = mobile === u.mobile ? null : mobile;
    const purpose = u.pendingMobile ? 'mobile_change' : 'mobile_verify';
    audit(req.user, 'MOBILE_CHANGE_REQUESTED', 'user', u.id, { to: maskMobile(mobile) });
    return createChallenge({ subjectId: u.id, purpose, destination: mobile, kind: 'otp' });
  });
  res.status(201).json({ ...challengeView(challenge, maskMobile(mobile)), ...(DEV ? { devCode: secret } : {}) });
});

r.post('/cancel-contact-change', (req, res) => {
  const u = me(req);
  tx(() => {
    if (req.body?.type === 'email') u.pendingEmail = null;
    else u.pendingMobile = null;
  });
  res.json(publicUser(u));
});

/** Agents may read the profile of customers whose applications are assigned to them (no credentials). */
r.get('/customers/:id', requireRole('agent', 'underwriter', 'admin'), (req, res) => {
  const c = db.get('users', req.params.id);
  if (!c || c.role !== 'customer') throw notFound('Customer not found');
  if (req.user.role === 'agent') {
    const assigned = db.findOne('applications', (a) => a.userId === c.id && a.review?.reviewer?.id === req.user.id);
    if (!assigned) throw forbidden('This customer is not assigned to you.');
  }
  tx(() => audit(req.user, 'CUSTOMER_PROFILE_VIEWED', 'user', c.id));
  res.json(publicUser(c, { masked: true }));
});

export default r;
