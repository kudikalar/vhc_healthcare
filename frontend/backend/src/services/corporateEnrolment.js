// Group policies, employee roster, dependents, enrolment, insurer confirmations, endorsements and
// renewals (spec §28, §30).
//
// Insurer confirmation is a separate step from submission: every group policy, enrolment and mid-term
// endorsement creates an insurerConfirmations record that the (sandbox) insurer decides. The sandbox
// insurer follows meta().mockInsurer.issuanceMode: 'auto' confirms immediately, 'manual' leaves the
// record pending until an admin / sandbox-insurer user decides it, 'decline' rejects it.
//
// Mid-term additions and deletions are endorsements priced by DAILY PRO-RATA (sandbox assumption,
// see corporateProduct.proRata); a real insurer's endorsement rules override it.
import crypto from 'node:crypto';
import { db, meta, nextSeq, tx } from '../db.js';
import { now, today } from '../clock.js';
import { bad, conflict, notFound, unprocessable } from '../utils/errors.js';
import { addDays, addYears, ageOn, diffDays, isValidDate } from '../utils/dates.js';
import { pct, sum } from '../utils/money.js';
import { audit, notify } from './audit.js';
import { newCorrelationId, publish } from './events.js';
import { SANDBOX_INSURER_ID } from './insurerHub.js';
import { cleanEmail, cleanName } from './security.js';
import { registerJob } from './jobs.js';
import { activeContract, CORP, createQuote, EMPLOYMENT_TYPES, SANDBOX_LABEL } from './corporate.js';
import { DEPENDENT_RELATIONSHIPS, FAMILY_DEFINITIONS, GROUP_PRODUCTS, lifePremium, productById, proRata } from './corporateProduct.js';

export const POLICY_STATUS = { PENDING: 'Pending Insurer', ACTIVE: 'Active', DECLINED: 'Declined by Insurer', EXPIRED: 'Expired' };
export const ENROL = { NOT: 'Not Enrolled', PENDING: 'Pending Insurer', ENROLLED: 'Enrolled', REJECTED: 'Rejected by Insurer', ENDED: 'Ended' };
export const PRO_RATA_ASSUMPTION = 'Daily pro-rata on the annual per-life premium (sandbox assumption — the insurer\'s endorsement rules override this in production).';
export const GENDERS = ['male', 'female', 'other'];
const INSURER_ACTOR = { id: null, name: 'VHC Sandbox Insurer (Synthetic)', role: 'insurer' };
const hex = () => crypto.randomBytes(4).toString('hex').toUpperCase();
const seq = (name, prefix, pad = 6) => `${prefix}${String(nextSeq(name)).padStart(pad, '0')}`;

const corpUsers = (employerId) => db.find('users', (u) => u.orgId === employerId && CORP.includes(u.role) && u.status === 'Active');
function notifyEmployer(employerId, title, message, opts) {
  for (const u of corpUsers(employerId)) notify(u.id, title, message, { ...opts, dedupeKey: opts?.dedupeKey ? `${opts.dedupeKey}:${u.id}` : undefined });
}

// =====================================================================================
// Group policies
// =====================================================================================
function cleanEligibility(e = {}, f) {
  const employmentTypes = (Array.isArray(e.employmentTypes) && e.employmentTypes.length ? e.employmentTypes : ['full_time', 'contract']);
  if (employmentTypes.some((t) => !EMPLOYMENT_TYPES.includes(t))) f['eligibility.employmentTypes'] = `Employment types must be from ${EMPLOYMENT_TYPES.join(', ')}.`;
  const minServiceDays = e.minServiceDays == null || e.minServiceDays === '' ? 0 : Number(e.minServiceDays);
  if (!Number.isInteger(minServiceDays) || minServiceDays < 0 || minServiceDays > 365) f['eligibility.minServiceDays'] = 'Minimum service must be 0–365 days.';
  const grades = (Array.isArray(e.grades) ? e.grades : String(e.grades || '').split(',')).map((g) => String(g).trim()).filter(Boolean).slice(0, 50);
  return { employmentTypes, minServiceDays, grades };
}

function cleanDependentRules(rules = {}, familyDefinition, product, f) {
  const rels = FAMILY_DEFINITIONS[familyDefinition]?.relationships || [];
  const d = product.defaultDependentRules;
  const num = (k, max) => {
    const v = rules[k] == null || rules[k] === '' ? d[k] : Number(rules[k]);
    if (!Number.isInteger(v) || v < 0 || v > max) f[`dependentRules.${k}`] = `Must be 0–${max}.`;
    return v;
  };
  return {
    spouse: rels.includes('spouse'), children: rels.includes('child'), parents: rels.includes('parent'),
    maxSpouses: 1, maxChildren: num('maxChildren', 6), childMaxAge: num('childMaxAge', 26), maxParents: num('maxParents', 4), parentMaxAge: num('parentMaxAge', 80),
  };
}

export const windowOpen = (p, on = today()) => !!p.enrolmentWindow && p.enrolmentWindow.opensOn <= on && on <= p.enrolmentWindow.closesOn;

/** Creates a group policy and requests the sandbox insurer's confirmation of the master policy. */
export function createGroupPolicy(actor, emp, body = {}) {
  const product = productById(body.productId || GROUP_PRODUCTS[0].id);
  if (!product) throw unprocessable('Select a group product.', { fields: { productId: 'Unknown product.' } });
  const insurer = db.get('insurers', product.insurerId);
  if (product.insurerId !== SANDBOX_INSURER_ID || !insurer?.sandbox || insurer.status !== 'Active') throw conflict('Group products are authorised only for the active sandbox insurer.');
  if (process.env.PAYMENT_MODE === 'live') throw conflict('Sandbox group products cannot be placed in live mode.');
  if (!['Contracted', 'Active'].includes(emp.status)) throw conflict(`The employer must be Contracted or Active (currently ${emp.status}).`);
  const f = {};
  let quote = null;
  if (body.quoteId) {
    quote = db.get('groupQuotes', body.quoteId);
    if (!quote || quote.employerId !== emp.id) f.quoteId = 'Quote not found for this employer.';
  }
  const sumInsured = Number(body.sumInsured ?? quote?.sumInsured);
  if (!product.sumInsuredOptions.includes(sumInsured)) f.sumInsured = 'Select a sum insured offered on this product.';
  const familyDefinition = body.familyDefinition || quote?.familyDefinition || 'ESC';
  if (!FAMILY_DEFINITIONS[familyDefinition]) f.familyDefinition = 'Select a family definition.';
  const startDate = body.startDate || quote?.startDate;
  if (!isValidDate(startDate)) f.startDate = 'Enter a valid policy start date.';
  const contract = body.contractId ? db.get('corporateContracts', body.contractId) : activeContract(emp.id, startDate);
  if (!contract || contract.employerId !== emp.id || contract.status !== 'Active' || !contract.services.includes('group_health')) f.contractId = 'An active corporate contract that includes group health is required.';
  const eligibility = cleanEligibility(body.eligibility, f);
  const dependentRules = cleanDependentRules(body.dependentRules, familyDefinition, product, f);
  const win = body.enrolmentWindow || {};
  const opensOn = win.opensOn || today();
  const closesOn = win.closesOn || addDays(isValidDate(startDate) && startDate > today() ? startDate : today(), 30);
  if (!isValidDate(opensOn) || !isValidDate(closesOn) || closesOn < opensOn) f.enrolmentWindow = 'Enter a valid enrolment window (close on or after open).';
  if (Object.keys(f).length) throw unprocessable('Please correct the highlighted fields.', { fields: f });
  const endDate = addDays(addYears(startDate, 1), -1);
  const overlap = db.findOne('groupPolicies', (p) => p.employerId === emp.id && p.productId === product.id && [POLICY_STATUS.PENDING, POLICY_STATUS.ACTIVE].includes(p.status) && p.startDate <= endDate && p.endDate >= startDate);
  if (overlap) throw conflict(`Group policy ${overlap.policyNumber} already covers part of this period.`);
  return tx(() => {
    const p = db.insert('groupPolicies', {
      policyNumber: seq('groupPolicy', 'GP-SBX-'), employerId: emp.id, employerName: emp.name, contractId: contract.id, quoteId: quote?.id || null,
      productId: product.id, productName: product.name, insurerId: product.insurerId, insurerName: product.insurerName, sandbox: true, label: SANDBOX_LABEL,
      startDate, endDate, status: POLICY_STATUS.PENDING, insurerReference: null,
      terms: {
        productId: product.id, sumInsured, familyDefinition, familyLabel: FAMILY_DEFINITIONS[familyDefinition].label,
        ageBands: product.ageBands, sumInsuredMultiplierBp: product.sumInsuredMultiplierBp[sumInsured], gstBp: 1800, waivers: product.waivers, premiumBasis: product.premiumBasis,
      },
      eligibility, dependentRules, enrolmentWindow: { opensOn, closesOn }, renewalOf: body.renewalOf || null, renewedBy: null,
      contacts: product.contacts, createdBy: actor.name,
    });
    audit(actor, 'GROUP_POLICY_CREATED', 'groupPolicy', p.id, { employerId: emp.id, policyNumber: p.policyNumber, sumInsured });
    requestConfirmation('group_policy', p, actor);
    return p;
  });
}

export function setEnrolmentWindow(actor, policy, { opensOn, closesOn }) {
  if (!isValidDate(opensOn) || !isValidDate(closesOn) || closesOn < opensOn) throw unprocessable('Enter a valid enrolment window (close on or after open).', { fields: { closesOn: 'Must be on or after the opening date.' } });
  if (closesOn > policy.endDate) throw unprocessable('The window must close before the policy ends.', { fields: { closesOn: `On or before ${policy.endDate}.` } });
  if ([POLICY_STATUS.DECLINED, POLICY_STATUS.EXPIRED].includes(policy.status)) throw conflict(`Policy is ${policy.status}`);
  return tx(() => {
    policy.enrolmentWindow = { opensOn, closesOn };
    db.touch(policy);
    audit(actor, 'ENROLMENT_WINDOW_SET', 'groupPolicy', policy.id, { opensOn, closesOn });
    notifyEmployer(policy.employerId, 'Enrolment window updated', `Enrolment for ${policy.policyNumber} is open ${opensOn} to ${closesOn}.`, { link: `/corporate/policies/${policy.id}` });
    return policy;
  });
}

/** Policies employees can currently enrol into (insurer-confirmed and not ended). */
export const openPolicies = (employerId, on = today()) =>
  db.find('groupPolicies', (p) => p.employerId === employerId && p.status === POLICY_STATUS.ACTIVE && p.endDate >= on).sort((a, b) => a.startDate.localeCompare(b.startDate));

export function policyStats(p) {
  const members = db.find('groupMembers', (m) => m.employerId === p.employerId);
  const enrols = db.find('groupEnrolments', (e) => e.groupPolicyId === p.id);
  const byMember = new Map(enrols.map((e) => [e.memberId, e]));
  let eligible = 0;
  for (const m of members) if (eligibilityFor(p, m).eligible || ['Enrolled', 'Pending Insurer', 'Ended'].includes(byMember.get(m.id)?.status)) eligible += 1;
  const enrolled = enrols.filter((e) => e.status === ENROL.ENROLLED);
  const coveredLives = enrolled.flatMap((e) => e.lives.filter((l) => l.status === 'Covered'));
  return {
    eligible, enrolled: enrolled.length, pending: enrols.filter((e) => e.status === ENROL.PENDING).length, rejected: enrols.filter((e) => e.status === ENROL.REJECTED).length,
    ended: enrols.filter((e) => e.status === ENROL.ENDED).length, coveredLives: coveredLives.length, coveredDependents: coveredLives.filter((l) => l.relationship !== 'self').length,
    annualPremium: sum(coveredLives, (l) => l.annualPremium), completionBp: eligible ? Math.round((enrolled.length * 10000) / eligible) : 0,
  };
}

export function policyView(p) {
  return { ...p, stats: policyStats(p), windowOpen: windowOpen(p), daysToEnd: diffDays(today(), p.endDate), product: productById(p.productId) };
}

// =====================================================================================
// Insurer confirmations (sandbox)
// =====================================================================================
const APPLY = {
  group_policy(c, decision, actor) {
    const p = db.get('groupPolicies', c.refId);
    if (!p || p.status !== POLICY_STATUS.PENDING) throw conflict('Group policy is not awaiting insurer confirmation');
    if (decision === 'confirmed') {
      Object.assign(p, { status: POLICY_STATUS.ACTIVE, insurerReference: c.insurerReference, confirmedAt: now().toISOString() });
      notifyEmployer(p.employerId, 'Group policy confirmed', `${p.policyNumber} (${p.productName}) was confirmed by the insurer. Enrolment is open ${p.enrolmentWindow.opensOn} to ${p.enrolmentWindow.closesOn}.`, { type: 'success', link: `/corporate/policies/${p.id}` });
    } else {
      Object.assign(p, { status: POLICY_STATUS.DECLINED, declineReason: c.reason });
      notifyEmployer(p.employerId, 'Group policy not confirmed', `The insurer did not confirm ${p.policyNumber}: ${c.reason}`, { type: 'error', link: `/corporate/policies/${p.id}` });
    }
    db.touch(p);
  },
  enrolment(c, decision, actor) {
    const e = db.get('groupEnrolments', c.refId);
    if (!e || e.status !== ENROL.PENDING) throw conflict('Enrolment is not awaiting insurer confirmation');
    const p = db.get('groupPolicies', e.groupPolicyId);
    const m = db.get('groupMembers', e.memberId);
    const en = e.endorsementId ? db.get('endorsements', e.endorsementId) : null;
    if (decision === 'confirmed') {
      Object.assign(e, { status: ENROL.ENROLLED, confirmedAt: now().toISOString(), insurerMemberRef: c.insurerReference, certificateNumber: e.certificateNumber || `COI-${p.policyNumber.replace('GP-SBX-', '')}-${String(nextSeq(`coi:${p.id}`)).padStart(5, '0')}` });
      for (const l of e.lives) l.status = 'Covered';
      if (en) Object.assign(en, { status: 'Confirmed', confirmedAt: now().toISOString(), insurerReference: c.insurerReference });
      e.history.push({ at: now().toISOString(), status: ENROL.ENROLLED, by: actor.name, note: `Confirmed by insurer (${c.insurerReference})` });
      publish('CORPORATE_MEMBER_ENROLLED', { employerId: e.employerId, groupPolicyId: p.id, memberId: e.memberId, enrolmentId: e.id, lives: e.lives.length }, {
        correlationId: e.correlationId, idempotencyKey: `corp-member-enrolled:${e.id}`, actor, subject: { type: 'groupEnrolment', id: e.id },
      });
      if (m?.userId) notify(m.userId, 'Your group health cover is confirmed', `You are covered under ${p.productName} (${p.policyNumber}) from ${e.coverFrom}. Download your certificate from Employee benefits.`, { type: 'success', link: '/benefits', dedupeKey: `corp-enrolled:${e.id}` });
    } else {
      Object.assign(e, { status: ENROL.REJECTED, rejectReason: c.reason });
      for (const l of e.lives) l.status = 'Not covered';
      if (en) Object.assign(en, { status: 'Rejected', rejectReason: c.reason });
      e.history.push({ at: now().toISOString(), status: ENROL.REJECTED, by: actor.name, note: c.reason });
      if (m?.userId) notify(m.userId, 'Enrolment not confirmed', `The insurer did not confirm your enrolment in ${p.policyNumber}. Your HR team has been informed.`, { type: 'error', link: '/benefits' });
    }
    db.touch(e);
  },
  endorsement(c, decision) {
    const en = db.get('endorsements', c.refId);
    if (!en || en.status !== 'Pending Insurer') throw conflict('Endorsement is not awaiting insurer confirmation');
    const e = en.enrolmentId ? db.get('groupEnrolments', en.enrolmentId) : null;
    if (decision === 'confirmed') {
      Object.assign(en, { status: 'Confirmed', confirmedAt: now().toISOString(), insurerReference: c.insurerReference });
      if (e && en.reason === 'dependent_added') e.lives.push(...en.pendingLives.map((l) => ({ ...l, status: 'Covered', endorsementId: en.id })));
      if (e && en.reason === 'dependent_removed') for (const l of e.lives) if (l.dependentId === en.dependentId && l.status === 'Covered') Object.assign(l, { status: 'Ended', coverTo: en.effectiveDate });
      if (e && en.reason === 'leaver') {
        for (const l of e.lives) if (l.status === 'Covered') Object.assign(l, { status: 'Ended', coverTo: en.effectiveDate });
        Object.assign(e, { status: ENROL.ENDED, coverTo: en.effectiveDate });
        e.history.push({ at: now().toISOString(), status: ENROL.ENDED, by: 'Insurer', note: `Deletion endorsement ${en.endorsementNumber} effective ${en.effectiveDate}` });
      }
      if (e) e.annualPremium = sum(e.lives.filter((l) => l.status === 'Covered'), (l) => l.annualPremium);
      const dep = en.dependentId ? db.get('groupDependents', en.dependentId) : null;
      if (dep) dep.coverStatus = en.reason === 'dependent_added' ? 'Covered' : `Cover ended ${en.effectiveDate}`;
    } else {
      Object.assign(en, { status: 'Rejected', rejectReason: c.reason });
      if (en.dependentId && en.reason === 'dependent_added') {
        const dep = db.get('groupDependents', en.dependentId);
        if (dep) dep.coverStatus = 'Not covered (insurer rejected endorsement)';
      }
    }
    if (e) db.touch(e);
    db.touch(en);
  },
};

export function requestConfirmation(kind, rec, actor) {
  const open = db.findOne('insurerConfirmations', (c) => c.kind === kind && c.refId === rec.id && c.status === 'pending');
  if (open) return open;
  const attempt = db.find('insurerConfirmations', (c) => c.kind === kind && c.refId === rec.id).length + 1;
  const mode = meta().mockInsurer?.issuanceMode || 'auto';
  const c = db.insert('insurerConfirmations', {
    reference: seq('insurerConfirmation', 'ICF-'), kind, refId: rec.id, refNumber: rec.policyNumber || rec.endorsementNumber || rec.enrolmentNumber || null,
    employerId: rec.employerId, groupPolicyId: kind === 'group_policy' ? rec.id : rec.groupPolicyId, insurerId: SANDBOX_INSURER_ID,
    status: 'pending', attempt, mode, requestedAt: now().toISOString(), requestedBy: actor?.name || 'System', idempotencyKey: `corp-confirm:${kind}:${rec.id}:${attempt}`,
  });
  rec.confirmationId = c.id;
  if (mode === 'auto') decideConfirmation(c, { decision: 'confirmed' }, INSURER_ACTOR);
  else if (mode === 'decline') decideConfirmation(c, { decision: 'rejected', reason: 'Sandbox insurer declined (simulated underwriting decision)' }, INSURER_ACTOR);
  return c;
}

/** Applies the insurer's decision. Deciding twice is rejected (409), so callbacks are idempotent. */
export function decideConfirmation(c, { decision, reason, insurerReference }, actor) {
  if (!c) throw notFound('Confirmation not found');
  if (c.status !== 'pending') throw conflict(`This request was already ${c.status}`);
  if (!['confirmed', 'rejected'].includes(decision)) throw bad('decision must be confirmed or rejected');
  if (decision === 'rejected' && !String(reason || '').trim()) throw unprocessable('A reason is required to reject.', { fields: { reason: 'Enter a reason.' } });
  return tx(() => {
    Object.assign(c, {
      status: decision, decidedAt: now().toISOString(), decidedBy: actor?.name || 'Insurer', decidedByRole: actor?.role || 'insurer',
      reason: decision === 'rejected' ? String(reason).trim().slice(0, 500) : null,
      insurerReference: decision === 'confirmed' ? String(insurerReference || `SBX-${c.kind === 'group_policy' ? 'GMP' : c.kind === 'enrolment' ? 'MEM' : 'END'}-${hex()}`).slice(0, 60) : null,
    });
    APPLY[c.kind](c, decision, actor || INSURER_ACTOR);
    db.touch(c);
    audit(actor || INSURER_ACTOR, decision === 'confirmed' ? 'INSURER_CONFIRMED' : 'INSURER_REJECTED', 'insurerConfirmation', c.id, { kind: c.kind, refId: c.refId, reason: c.reason });
    return c;
  });
}

// =====================================================================================
// Roster: members, CSV import, joiners and leavers
// =====================================================================================
export const CSV_REQUIRED = ['employeeId', 'name', 'email', 'dob', 'gender', 'grade', 'joiningDate'];
export const CSV_OPTIONAL = ['employmentType', 'location'];
export const MAX_IMPORT_ROWS = 5000;
const EMP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9\-_/]{0,29}$/;

/** RFC 4180-style CSV parser (quoted fields, escaped quotes, CRLF). Returns an array of string arrays. */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  const s = String(text ?? '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"' && s[i + 1] === '"') { field += '"'; i++; } else if (ch === '"') q = false; else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(field); field = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** Validates one roster entry. Returns { value, errors: [{ field, message }] }. */
export function validateMember(raw, { employerId, seenIds = new Set(), seenEmails = new Set(), excludeId = null } = {}) {
  const errors = [];
  const err = (field, message) => errors.push({ field, message });
  const employeeId = String(raw.employeeId ?? '').trim();
  if (!EMP_ID_RE.test(employeeId)) err('employeeId', 'Employee ID is required (letters, digits, - _ /; max 30).');
  else if (seenIds.has(employeeId.toLowerCase()) || db.findOne('groupMembers', (m) => m.employerId === employerId && m.id !== excludeId && m.employeeId.toLowerCase() === employeeId.toLowerCase())) err('employeeId', `Employee ID ${employeeId} is already on the roster.`);
  const name = cleanName(raw.name, { max: 100 });
  if (!name) err('name', 'Enter the employee\'s full name (letters only).');
  const email = cleanEmail(raw.email);
  if (!email) err('email', 'Enter a valid email address.');
  else if (seenEmails.has(email.toLowerCase()) || db.findOne('groupMembers', (m) => m.employerId === employerId && m.id !== excludeId && m.status === 'Active' && m.emailLower === email.toLowerCase())) err('email', `${email} is already used by another employee.`);
  const dob = String(raw.dob ?? '').trim();
  if (!isValidDate(dob)) err('dob', 'Date of birth must be YYYY-MM-DD.');
  else if (ageOn(dob, today()) < 18 || ageOn(dob, today()) > 80) err('dob', 'Employee must be 18–80 years old.');
  const gender = String(raw.gender ?? '').trim().toLowerCase();
  if (!GENDERS.includes(gender)) err('gender', 'Gender must be male, female or other.');
  const grade = String(raw.grade ?? '').trim();
  if (!grade || grade.length > 20) err('grade', 'Grade is required (max 20 characters).');
  const joiningDate = String(raw.joiningDate ?? '').trim();
  if (!isValidDate(joiningDate)) err('joiningDate', 'Joining date must be YYYY-MM-DD.');
  else if (joiningDate > addDays(today(), 90)) err('joiningDate', 'Joining date cannot be more than 90 days ahead.');
  else if (isValidDate(dob) && ageOn(dob, joiningDate) < 18) err('joiningDate', 'Employee must be at least 18 on the joining date.');
  const employmentType = String(raw.employmentType || 'full_time').trim().toLowerCase().replace(/[\s-]/g, '_');
  if (!EMPLOYMENT_TYPES.includes(employmentType)) err('employmentType', `Employment type must be one of ${EMPLOYMENT_TYPES.join(', ')}.`);
  const location = String(raw.location ?? '').trim().slice(0, 60);
  return { value: { employeeId, name, email, emailLower: email?.toLowerCase(), dob, gender, grade, joiningDate, employmentType, location }, errors };
}

/** Links a roster entry to a customer account whose VERIFIED email matches. */
function linkCustomer(member, actor) {
  if (member.userId) return false;
  const u = db.findOne('users', (x) => x.role === 'customer' && x.emailVerified && x.active && x.emailLower === member.emailLower);
  if (!u) return false;
  Object.assign(member, { userId: u.id, linkedAt: now().toISOString() });
  audit(actor, 'CORPORATE_EMPLOYEE_LINKED', 'groupMember', member.id, { userId: u.id });
  notify(u.id, 'Employer benefits available', 'Your employer has added you to its group health benefits on VHC. Review your cover and complete enrolment.', { link: '/benefits', dedupeKey: `corp-benefits:${member.id}` });
  return true;
}

function insertMember(actor, emp, value, source) {
  const m = db.insert('groupMembers', {
    employerId: emp.id, ...value, status: 'Active', leavingDate: null, userId: null, linkedAt: null, inviteSentAt: null, source,
    history: [{ at: now().toISOString(), event: 'joined', by: actor.name, note: `Added (${source}); joining date ${value.joiningDate}` }],
  });
  linkCustomer(m, actor);
  return m;
}

export function importRoster(actor, emp, { csv, dryRun = false, skipInvalid = false } = {}) {
  const rows = parseCsv(csv);
  if (!rows.length) throw unprocessable('The file is empty.', { errors: ['The file is empty.'] });
  const header = rows[0].map((h) => h.trim());
  const idx = Object.fromEntries([...CSV_REQUIRED, ...CSV_OPTIONAL].map((c) => [c, header.findIndex((h) => h.toLowerCase() === c.toLowerCase())]));
  const missing = CSV_REQUIRED.filter((c) => idx[c] < 0);
  if (missing.length) throw unprocessable(`Missing required column(s): ${missing.join(', ')}`, { errors: [`Header must include: ${CSV_REQUIRED.join(', ')}`], rowErrors: [{ row: 1, field: 'header', message: `Missing: ${missing.join(', ')}` }] });
  const body = rows.slice(1);
  if (body.length > MAX_IMPORT_ROWS) throw unprocessable(`At most ${MAX_IMPORT_ROWS} rows can be imported at once.`);
  const seenIds = new Set(), seenEmails = new Set();
  const valid = [], rowErrors = [];
  body.forEach((cells, i) => {
    const raw = Object.fromEntries(Object.entries(idx).filter(([, j]) => j >= 0).map(([k, j]) => [k, cells[j] ?? '']));
    const { value, errors } = validateMember(raw, { employerId: emp.id, seenIds, seenEmails });
    const row = i + 2; // 1-based, header is row 1
    if (errors.length) rowErrors.push(...errors.map((e) => ({ row, employeeId: value.employeeId || null, ...e })));
    else valid.push({ row, value });
    if (value.employeeId) seenIds.add(value.employeeId.toLowerCase());
    if (value.emailLower) seenEmails.add(value.emailLower);
  });
  const summary = { totalRows: body.length, validRows: valid.length, invalidRows: new Set(rowErrors.map((e) => e.row)).size, rowErrors };
  if (dryRun) return { ...summary, imported: 0, dryRun: true };
  if (rowErrors.length && !skipInvalid) throw unprocessable(`${summary.invalidRows} row(s) have errors; nothing was imported. Fix them or import only the valid rows.`, summary);
  return tx(() => {
    const created = valid.map(({ value }) => insertMember(actor, emp, value, 'csv'));
    audit(actor, 'CORPORATE_ROSTER_IMPORTED', 'employer', emp.id, { imported: created.length, skipped: summary.invalidRows });
    return { ...summary, imported: created.length, memberIds: created.map((m) => m.id) };
  });
}

export function addMember(actor, emp, body = {}) {
  const { value, errors } = validateMember(body, { employerId: emp.id });
  if (errors.length) throw unprocessable('Please correct the highlighted fields.', { fields: Object.fromEntries(errors.map((e) => [e.field, e.message])) });
  return tx(() => {
    const m = insertMember(actor, emp, value, 'single');
    audit(actor, 'CORPORATE_EMPLOYEE_ADDED', 'groupMember', m.id, { employeeId: m.employeeId });
    return m;
  });
}

export function updateMember(actor, m, body = {}) {
  if (m.status !== 'Active') throw conflict('Only active employees can be edited');
  const merged = { ...m, ...Object.fromEntries(['name', 'email', 'grade', 'employmentType', 'location'].filter((k) => body[k] !== undefined).map((k) => [k, body[k]])) };
  const { value, errors } = validateMember(merged, { employerId: m.employerId, excludeId: m.id });
  const relevant = errors.filter((e) => ['name', 'email', 'grade', 'employmentType'].includes(e.field));
  if (relevant.length) throw unprocessable('Please correct the highlighted fields.', { fields: Object.fromEntries(relevant.map((e) => [e.field, e.message])) });
  return tx(() => {
    const emailChanged = value.emailLower !== m.emailLower;
    Object.assign(m, { name: value.name, email: value.email, emailLower: value.emailLower, grade: value.grade, employmentType: value.employmentType, location: value.location });
    if (emailChanged && m.userId) Object.assign(m, { userId: null, linkedAt: null }); // re-link only via the new verified email
    if (emailChanged) linkCustomer(m, actor);
    m.history.push({ at: now().toISOString(), event: 'updated', by: actor.name, note: 'Roster details updated' });
    db.touch(m);
    audit(actor, 'CORPORATE_EMPLOYEE_UPDATED', 'groupMember', m.id, { fields: Object.keys(body) });
    return m;
  });
}

/** Employee invitation: an in-app notification when they already have a verified account, otherwise a (simulated) email asking them to register with that address. */
export function inviteMember(actor, m) {
  if (m.status !== 'Active') throw conflict('Only active employees can be invited');
  return tx(() => {
    const linked = linkCustomer(m, actor) || !!m.userId;
    if (m.userId) notify(m.userId, 'Review your employee benefits', 'Your HR team invited you to review your group health cover and complete enrolment.', { link: '/benefits' });
    else if (process.env.DB_IN_MEMORY !== '1') console.log(`[email:simulated] benefits invite -> ${m.email}: register or sign in at /register with this email, then open /benefits`);
    m.inviteSentAt = now().toISOString();
    m.inviteCount = (m.inviteCount || 0) + 1;
    db.touch(m);
    audit(actor, 'CORPORATE_EMPLOYEE_INVITED', 'groupMember', m.id, { linked });
    return { linked, channel: linked ? 'in-app + email (simulated)' : 'email (simulated)', registerPath: '/register', benefitsPath: '/benefits' };
  });
}

/** Links roster entries to a signed-in customer by verified email (called when they open /benefits). */
export function linkMembersForUser(userId) {
  const u = db.get('users', userId);
  if (!u || u.role !== 'customer' || !u.emailVerified) return [];
  const pending = db.find('groupMembers', (m) => !m.userId && m.emailLower === u.emailLower);
  if (!pending.length) return [];
  return tx(() => pending.filter((m) => linkCustomer(m, { id: u.id, role: u.role, name: u.name })));
}

export function leaveMember(actor, m, { leavingDate } = {}) {
  if (m.status !== 'Active') throw conflict('Employee is not active on the roster');
  if (!isValidDate(leavingDate)) throw unprocessable('Enter the last working day.', { fields: { leavingDate: 'Enter a valid date.' } });
  if (leavingDate < m.joiningDate) throw unprocessable('Leaving date cannot be before the joining date.', { fields: { leavingDate: `On or after ${m.joiningDate}.` } });
  if (leavingDate > addDays(today(), 90)) throw unprocessable('Leaving date cannot be more than 90 days ahead.', { fields: { leavingDate: 'Too far ahead.' } });
  const enrols = db.find('groupEnrolments', (e) => e.memberId === m.id);
  if (enrols.some((e) => e.status === ENROL.PENDING)) throw conflict('An enrolment for this employee is awaiting insurer confirmation. Wait for the decision, then record the exit.');
  return tx(() => {
    const endorsements = [];
    for (const e of enrols.filter((x) => x.status === ENROL.ENROLLED)) {
      const p = db.get('groupPolicies', e.groupPolicyId);
      if (!p || leavingDate >= p.endDate) continue; // cover runs to term end anyway: no deletion needed
      const lives = e.lives.filter((l) => l.status === 'Covered');
      // Leaving before cover started → the whole addition is reversed (effective the day before cover).
      const effectiveDate = leavingDate < e.coverFrom ? addDays(e.coverFrom, -1) : leavingDate;
      endorsements.push(createEndorsement(actor, p, { type: 'deletion', reason: 'leaver', memberId: m.id, enrolmentId: e.id, effectiveDate, lives }));
    }
    for (const e of enrols.filter((x) => [ENROL.NOT, ENROL.REJECTED].includes(x.status))) Object.assign(e, { status: ENROL.ENDED, coverTo: null });
    Object.assign(m, { status: 'Left', leavingDate });
    m.history.push({ at: now().toISOString(), event: 'left', by: actor.name, note: `Leaving date ${leavingDate}` });
    db.touch(m);
    audit(actor, 'CORPORATE_EMPLOYEE_LEFT', 'groupMember', m.id, { leavingDate, endorsements: endorsements.map((x) => x.endorsementNumber) });
    return { member: m, endorsements };
  });
}

// =====================================================================================
// Dependents
// =====================================================================================
export function rulesFor(employerId) {
  const p = openPolicies(employerId)[0];
  if (p) return { policy: p, rules: p.dependentRules, relationships: FAMILY_DEFINITIONS[p.terms.familyDefinition].relationships.filter((r) => r !== 'self') };
  const d = GROUP_PRODUCTS[0].defaultDependentRules;
  return { policy: null, rules: { spouse: true, children: true, parents: true, ...d }, relationships: DEPENDENT_RELATIONSHIPS };
}

export function addDependent(actor, m, body = {}) {
  if (m.status !== 'Active') throw conflict('Dependents can be added only for active employees');
  const { policy, rules, relationships } = rulesFor(m.employerId);
  const f = {};
  const name = cleanName(body.name, { max: 100 });
  if (!name) f.name = 'Enter the dependent\'s full name.';
  const relationship = body.relationship;
  if (!DEPENDENT_RELATIONSHIPS.includes(relationship)) f.relationship = 'Relationship must be spouse, child or parent.';
  else if (!relationships.includes(relationship)) f.relationship = `${relationship[0].toUpperCase()}${relationship.slice(1)} cover is not included in your employer's family definition.`;
  const gender = String(body.gender || '').toLowerCase();
  if (!GENDERS.includes(gender)) f.gender = 'Select a gender.';
  const dob = body.dob;
  if (!isValidDate(dob) || dob > today()) f.dob = 'Enter a valid date of birth (not in the future).';
  if (!f.relationship && !f.dob) {
    const age = ageOn(dob, today());
    const existing = db.find('groupDependents', (d) => d.memberId === m.id && d.status === 'Active');
    const count = (r) => existing.filter((d) => d.relationship === r).length;
    if (relationship === 'spouse' && count('spouse') >= rules.maxSpouses) f.relationship = 'A spouse is already registered.';
    if (relationship === 'spouse' && age < 18) f.dob = 'Spouse must be at least 18.';
    if (relationship === 'child' && count('child') >= rules.maxChildren) f.relationship = `At most ${rules.maxChildren} children can be covered.`;
    if (relationship === 'child' && age > rules.childMaxAge) f.dob = `Children are covered up to age ${rules.childMaxAge}.`;
    if (relationship === 'child' && dob <= m.dob) f.dob = 'A child must be younger than the employee.';
    if (relationship === 'parent' && count('parent') >= rules.maxParents) f.relationship = `At most ${rules.maxParents} parents can be covered.`;
    if (relationship === 'parent' && age > rules.parentMaxAge) f.dob = `Parents are covered up to age ${rules.parentMaxAge}.`;
    if (relationship === 'parent' && dob >= m.dob) f.dob = 'A parent must be older than the employee.';
    if (name && existing.some((d) => d.name.toLowerCase() === name.toLowerCase() && d.dob === dob)) f.name = 'This dependent is already registered.';
  }
  if (Object.keys(f).length) throw unprocessable('Please correct the highlighted fields.', { fields: f });
  const e = policy && db.findOne('groupEnrolments', (x) => x.groupPolicyId === policy.id && x.memberId === m.id);
  if (e?.status === ENROL.PENDING) throw conflict('Enrolment is awaiting insurer confirmation. Add dependents after it is confirmed.');
  let effectiveDate = null;
  if (e?.status === ENROL.ENROLLED) {
    effectiveDate = body.effectiveDate || today();
    if (!isValidDate(effectiveDate) || effectiveDate < e.coverFrom || effectiveDate > policy.endDate) throw unprocessable('Effective date must fall within the employee\'s cover period.', { fields: { effectiveDate: `Between ${e.coverFrom} and ${policy.endDate}.` } });
    if (!lifePremium(policy.terms, dob, effectiveDate)) throw unprocessable('Dependent is outside the insurable age range.', { fields: { dob: 'Outside the insurable age range.' } });
  }
  return tx(() => {
    const dep = db.insert('groupDependents', {
      employerId: m.employerId, memberId: m.id, name, relationship, dob, gender, status: 'Active', addedBy: actor.name, addedByRole: actor.role,
      coverStatus: e?.status === ENROL.ENROLLED ? 'Pending insurer endorsement' : 'Included at enrolment',
    });
    let endorsement = null;
    if (e?.status === ENROL.ENROLLED) {
      const lp = lifePremium(policy.terms, dob, effectiveDate);
      const life = { lifeId: dep.id, dependentId: dep.id, name, relationship, dob, gender, age: lp.age, band: lp.band, annualPremium: lp.annualPremium, coverFrom: effectiveDate, coverTo: policy.endDate };
      endorsement = createEndorsement(actor, policy, { type: 'addition', reason: 'dependent_added', memberId: m.id, dependentId: dep.id, enrolmentId: e.id, effectiveDate, lives: [life] });
    }
    audit(actor, 'CORPORATE_DEPENDENT_ADDED', 'groupDependent', dep.id, { memberId: m.id, relationship, endorsement: endorsement?.endorsementNumber || null });
    return { dependent: dep, endorsement };
  });
}

export function removeDependent(actor, dep, { effectiveDate } = {}) {
  if (dep.status !== 'Active') throw conflict('Dependent is already removed');
  const e = db.findOne('groupEnrolments', (x) => x.memberId === dep.memberId && x.lives.some((l) => l.dependentId === dep.id && l.status === 'Covered') && x.status === ENROL.ENROLLED);
  if (db.findOne('groupEnrolments', (x) => x.memberId === dep.memberId && x.status === ENROL.PENDING)) throw conflict('Enrolment is awaiting insurer confirmation. Try again after it is decided.');
  let endorsement = null;
  return tx(() => {
    if (e) {
      const p = db.get('groupPolicies', e.groupPolicyId);
      const life = e.lives.find((l) => l.dependentId === dep.id && l.status === 'Covered');
      const eff = effectiveDate || today();
      if (!isValidDate(eff) || eff < life.coverFrom || eff > p.endDate) throw unprocessable('Effective date must fall within the cover period.', { fields: { effectiveDate: `Between ${life.coverFrom} and ${p.endDate}.` } });
      endorsement = createEndorsement(actor, p, { type: 'deletion', reason: 'dependent_removed', memberId: dep.memberId, dependentId: dep.id, enrolmentId: e.id, effectiveDate: eff, lives: [life] });
    }
    Object.assign(dep, { status: 'Removed', removedAt: now().toISOString(), removedBy: actor.name, coverStatus: !endorsement ? 'Not covered' : endorsement.status === 'Confirmed' ? `Cover ended ${endorsement.effectiveDate}` : endorsement.status === 'Rejected' ? 'Deletion rejected by insurer' : 'Deletion endorsement pending' });
    db.touch(dep);
    audit(actor, 'CORPORATE_DEPENDENT_REMOVED', 'groupDependent', dep.id, { endorsement: endorsement?.endorsementNumber || null });
    return { dependent: dep, endorsement };
  });
}

// =====================================================================================
// Eligibility & enrolment
// =====================================================================================
export function eligibilityFor(policy, m) {
  const reasons = [];
  if (m.status !== 'Active') reasons.push('Employee is not active on the roster');
  const el = policy.eligibility;
  if (!el.employmentTypes.includes(m.employmentType)) reasons.push(`Employment type "${m.employmentType.replace('_', ' ')}" is not eligible`);
  if (el.grades.length && !el.grades.includes(m.grade)) reasons.push(`Grade ${m.grade} is not eligible`);
  const serviceFrom = addDays(m.joiningDate, el.minServiceDays);
  const eligibleFrom = serviceFrom > policy.startDate ? serviceFrom : policy.startDate;
  if (eligibleFrom > policy.endDate) reasons.push('Becomes eligible only after this policy period');
  const age = ageOn(m.dob, eligibleFrom);
  if (age < 18 || age > 80) reasons.push('Outside the insurable age range (18–80)');
  return { eligible: !reasons.length, reasons, eligibleFrom };
}

function computeLives(policy, m, coverFrom) {
  const rels = FAMILY_DEFINITIONS[policy.terms.familyDefinition].relationships;
  const self = lifePremium(policy.terms, m.dob, coverFrom);
  if (!self) throw unprocessable(`${m.name} is outside the insurable age range.`);
  const lives = [{ lifeId: 'self', dependentId: null, name: m.name, relationship: 'self', dob: m.dob, gender: m.gender, age: self.age, band: self.band, annualPremium: self.annualPremium, coverFrom, coverTo: policy.endDate, status: 'Pending' }];
  const excluded = [];
  for (const d of db.find('groupDependents', (x) => x.memberId === m.id && x.status === 'Active')) {
    if (!rels.includes(d.relationship)) { excluded.push({ dependentId: d.id, name: d.name, reason: 'Not included in the family definition' }); continue; }
    const age = ageOn(d.dob, coverFrom);
    if (d.relationship === 'child' && age > policy.dependentRules.childMaxAge) { excluded.push({ dependentId: d.id, name: d.name, reason: `Child above age ${policy.dependentRules.childMaxAge}` }); continue; }
    if (d.relationship === 'parent' && age > policy.dependentRules.parentMaxAge) { excluded.push({ dependentId: d.id, name: d.name, reason: `Parent above age ${policy.dependentRules.parentMaxAge}` }); continue; }
    const lp = lifePremium(policy.terms, d.dob, coverFrom);
    if (!lp) { excluded.push({ dependentId: d.id, name: d.name, reason: 'Outside the insurable age range' }); continue; }
    lives.push({ lifeId: d.id, dependentId: d.id, name: d.name, relationship: d.relationship, dob: d.dob, gender: d.gender, age: lp.age, band: lp.band, annualPremium: lp.annualPremium, coverFrom, coverTo: policy.endDate, status: 'Pending' });
  }
  return { lives, excluded };
}

/** Submits one employee's enrolment to the insurer. Safe to retry: already pending/enrolled is a no-op. */
export function submitEnrolment(actor, policy, m, { source = 'hr' } = {}) {
  if (policy.status !== POLICY_STATUS.ACTIVE) throw conflict(`Group policy ${policy.policyNumber} is ${policy.status}; enrolment opens once the insurer confirms it.`);
  if (policy.endDate < today()) throw conflict('The group policy has ended');
  if (m.employerId !== policy.employerId) throw notFound('Employee not found');
  let e = db.findOne('groupEnrolments', (x) => x.groupPolicyId === policy.id && x.memberId === m.id);
  if (e && [ENROL.PENDING, ENROL.ENROLLED, ENROL.ENDED].includes(e.status)) return { enrolment: e, skipped: `Already ${e.status.toLowerCase()}` };
  const el = eligibilityFor(policy, m);
  if (!el.eligible) throw unprocessable(`${m.name} is not eligible: ${el.reasons.join('; ')}`, { problems: el.reasons });
  const t = today();
  // Window open → cover from eligibility date (policy start for existing staff). Window closed → late
  // entry from today (or from the future eligibility date of a recent joiner): a mid-term addition.
  const coverFrom = windowOpen(policy, t) || el.eligibleFrom > t ? el.eligibleFrom : t;
  const { lives, excluded } = computeLives(policy, m, coverFrom);
  return tx(() => {
    e ||= db.insert('groupEnrolments', { enrolmentNumber: seq('groupEnrolment', 'GE-'), groupPolicyId: policy.id, employerId: policy.employerId, memberId: m.id, history: [] });
    Object.assign(e, {
      status: ENROL.PENDING, coverFrom, coverTo: policy.endDate, lives, excludedLives: excluded, annualPremium: sum(lives, (l) => l.annualPremium), billablePremium: sum(lives, (l) => l.annualPremium),
      basePremium: coverFrom === policy.startDate, submittedAt: now().toISOString(), submittedBy: actor.name, source, correlationId: newCorrelationId(),
      endorsementId: null, rejectReason: null, invoiceId: null,
    });
    if (!e.basePremium) {
      const en = createEndorsement(actor, policy, { type: 'addition', reason: m.joiningDate > policy.startDate ? 'joiner' : 'late_enrolment', memberId: m.id, enrolmentId: e.id, effectiveDate: coverFrom, lives, viaEnrolment: true });
      e.endorsementId = en.id;
    }
    e.history.push({ at: now().toISOString(), status: ENROL.PENDING, by: actor.name, note: `Submitted to insurer (${lives.length} li${lives.length === 1 ? 'fe' : 'ves'}, cover from ${coverFrom})` });
    db.touch(e);
    audit(actor, 'GROUP_ENROLMENT_SUBMITTED', 'groupEnrolment', e.id, { memberId: m.id, groupPolicyId: policy.id, lives: lives.length, source });
    requestConfirmation('enrolment', e, actor);
    return { enrolment: e };
  });
}

/** HR bulk submission. memberIds omitted → every eligible employee not yet enrolled. */
export function bulkSubmit(actor, policy, memberIds) {
  const members = memberIds?.length
    ? memberIds.map((id) => db.get('groupMembers', id)).filter((m) => m && m.employerId === policy.employerId)
    : db.find('groupMembers', (m) => m.employerId === policy.employerId && m.status === 'Active');
  if (memberIds?.length && members.length !== memberIds.length) throw notFound('Employee not found');
  return tx(() => {
    const out = { submitted: [], skipped: [], errors: [] };
    for (const m of members) {
      try {
        const r = submitEnrolment(actor, policy, m);
        if (r.skipped) out.skipped.push({ memberId: m.id, employeeId: m.employeeId, reason: r.skipped });
        else out.submitted.push({ memberId: m.id, employeeId: m.employeeId, enrolmentId: r.enrolment.id, status: r.enrolment.status });
      } catch (err) {
        if (!err.status) throw err;
        if (memberIds?.length) out.errors.push({ memberId: m.id, employeeId: m.employeeId, error: err.message });
        else out.skipped.push({ memberId: m.id, employeeId: m.employeeId, reason: err.message });
      }
    }
    return out;
  });
}

/** Rows for the enrolment table: one per roster employee (virtual "Not Enrolled" rows have no id). */
export function enrolmentRows(policy) {
  const enrols = new Map(db.find('groupEnrolments', (e) => e.groupPolicyId === policy.id).map((e) => [e.memberId, e]));
  return db.find('groupMembers', (m) => m.employerId === policy.employerId && (m.status === 'Active' || enrols.has(m.id))).map((m) => {
    const e = enrols.get(m.id);
    const el = eligibilityFor(policy, m);
    return {
      memberId: m.id, employeeId: m.employeeId, name: m.name, grade: m.grade, memberStatus: m.status, eligible: el.eligible, eligibleFrom: el.eligibleFrom, reasons: el.reasons,
      enrolmentId: e?.id || null, status: e?.status || ENROL.NOT, coverFrom: e?.coverFrom || null, coverTo: e?.coverTo || null,
      lives: e ? e.lives.filter((l) => l.status !== 'Ended').length : 0, annualPremium: e?.annualPremium || 0, certificateNumber: e?.certificateNumber || null, rejectReason: e?.rejectReason || null,
    };
  });
}

// =====================================================================================
// Endorsements
// =====================================================================================
export function createEndorsement(actor, policy, { type, reason, memberId, dependentId = null, enrolmentId, effectiveDate, lives, viaEnrolment = false }) {
  const annual = sum(lives, (l) => l.annualPremium);
  const pr = proRata(annual, policy, effectiveDate, type);
  const gst = pct(pr.amount, policy.terms.gstBp);
  const en = db.insert('endorsements', {
    endorsementNumber: seq('endorsement', 'END-'), groupPolicyId: policy.id, policyNumber: policy.policyNumber, employerId: policy.employerId,
    memberId, dependentId, enrolmentId, type, reason, effectiveDate,
    lives: lives.map((l) => ({ lifeId: l.lifeId, relationship: l.relationship, band: l.band, annualPremium: l.annualPremium })),
    pendingLives: type === 'addition' && reason === 'dependent_added' ? lives : undefined,
    annualPremium: annual, days: pr.days, policyDays: pr.policyDays, proRataPremium: pr.amount, gstBp: policy.terms.gstBp, gst, total: pr.amount + gst,
    direction: type === 'addition' ? 'debit' : 'credit', status: 'Pending Insurer', confirmedVia: viaEnrolment ? 'enrolment' : 'endorsement',
    invoiceId: null, assumption: PRO_RATA_ASSUMPTION, createdBy: actor.name,
  });
  audit(actor, 'ENDORSEMENT_CREATED', 'endorsement', en.id, { type, reason, effectiveDate, amount: en.total });
  if (!viaEnrolment) requestConfirmation('endorsement', en, actor);
  return en;
}

export function endorsementView(en) {
  const m = db.get('groupMembers', en.memberId);
  const { pendingLives, ...rest } = en; // eslint-disable-line no-unused-vars
  return { ...rest, employeeId: m?.employeeId || null, employeeName: m?.name || null };
}

// =====================================================================================
// Renewals
// =====================================================================================
export function renewalsDue(employerIds, withinDays = 90) {
  const t = today();
  return db.find('groupPolicies', (p) => employerIds.includes(p.employerId) && [POLICY_STATUS.ACTIVE, POLICY_STATUS.EXPIRED].includes(p.status) && !p.renewedBy)
    .map((p) => ({ policy: p, daysLeft: diffDays(t, p.endDate) }))
    .filter((x) => x.daysLeft <= withinDays && x.daysLeft >= -30)
    .map(({ policy: p, daysLeft }) => {
      const q = db.find('groupQuotes', (x) => x.renewalOf === p.id).pop() || null;
      return { id: p.id, policyNumber: p.policyNumber, employerId: p.employerId, employerName: p.employerName, endDate: p.endDate, daysLeft, status: daysLeft < 0 ? 'Lapsed — renewal overdue' : 'Renewal due', renewalQuote: q ? { id: q.id, quoteNumber: q.quoteNumber, total: q.total, lives: q.lives } : null };
    })
    .sort((a, b) => a.daysLeft - b.daysLeft);
}

/** Renewal census: lives covered to the end of term, aged at the renewal start date. */
export function renewalCensus(policy) {
  const start = addDays(policy.endDate, 1);
  const product = productById(policy.productId);
  const counts = Object.fromEntries(product.ageBands.map((b) => [b.band, 0]));
  for (const e of db.find('groupEnrolments', (x) => x.groupPolicyId === policy.id && x.status === ENROL.ENROLLED)) {
    for (const l of e.lives.filter((x) => x.status === 'Covered')) {
      const lp = lifePremium(policy.terms, l.dob, start);
      if (lp) counts[lp.band] += 1;
    }
  }
  return { startDate: start, census: Object.entries(counts).map(([band, lives]) => ({ band, lives })) };
}

export function renewalQuote(actor, policy, emp) {
  if (![POLICY_STATUS.ACTIVE, POLICY_STATUS.EXPIRED].includes(policy.status)) throw conflict(`Policy is ${policy.status}`);
  const { startDate, census } = renewalCensus(policy);
  return createQuote(actor, emp, { productId: policy.productId, sumInsured: policy.terms.sumInsured, familyDefinition: policy.terms.familyDefinition, startDate, census, renewalOf: policy.id });
}

export function renewPolicy(actor, policy, emp, body = {}) {
  if (policy.renewedBy) throw conflict('This policy has already been renewed');
  if (![POLICY_STATUS.ACTIVE, POLICY_STATUS.EXPIRED].includes(policy.status)) throw conflict(`Policy is ${policy.status}`);
  return tx(() => {
    const next = createGroupPolicy(actor, emp, {
      productId: policy.productId, sumInsured: body.sumInsured ?? policy.terms.sumInsured, familyDefinition: body.familyDefinition || policy.terms.familyDefinition,
      startDate: addDays(policy.endDate, 1), quoteId: body.quoteId, contractId: body.contractId, eligibility: body.eligibility || policy.eligibility,
      dependentRules: body.dependentRules || policy.dependentRules, enrolmentWindow: body.enrolmentWindow, renewalOf: policy.id,
    });
    policy.renewedBy = next.id;
    db.touch(policy);
    audit(actor, 'GROUP_POLICY_RENEWED', 'groupPolicy', policy.id, { renewal: next.policyNumber });
    return next;
  });
}

// ---------- scheduled work ----------
registerJob(() => {
  const t = today();
  let expired = 0, renewalNotices = 0;
  for (const p of db.find('groupPolicies', (x) => x.status === POLICY_STATUS.ACTIVE)) {
    if (p.endDate < t) {
      p.status = POLICY_STATUS.EXPIRED;
      db.touch(p);
      expired += 1;
      continue;
    }
    const days = diffDays(t, p.endDate);
    if (!p.renewedBy && days <= 60) {
      for (const u of corpUsers(p.employerId)) {
        if (notify(u.id, 'Group policy renewal due', `${p.policyNumber} ends on ${p.endDate}. Review the renewal quote with your VHC account manager.`, { type: 'warning', link: `/corporate/policies/${p.id}`, dedupeKey: `corp-renewal:${p.id}:${u.id}` })) renewalNotices += 1;
      }
    }
  }
  return { corporatePoliciesExpired: expired, corporateRenewalNotices: renewalNotices };
});
