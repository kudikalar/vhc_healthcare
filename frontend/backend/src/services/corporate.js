// Corporate module core: employer registry & onboarding (spec §27), role scoping, employer user
// invitations, corporate contracts and census-based group quotations (§28).
//
// Tenancy: corporate_admin / corporate_hr users only ever see their own employer (user.orgId). A record
// that belongs to another employer is reported as 404, never 403, so its existence is not disclosed.
import { db, nextSeq, tx } from '../db.js';
import { now, today } from '../clock.js';
import { READ_ONLY_ROLES } from '../middleware/auth.js';
import { bad, conflict, forbidden, notFound, unprocessable } from '../utils/errors.js';
import { addDays, ageOn, isValidDate } from '../utils/dates.js';
import { audit, notify } from './audit.js';
import { createChallenge } from './challenges.js';
import { cleanEmail, cleanName, maskEmail, normalizeMobile, revokeAllSessions } from './security.js';
import { displayName, publicUser, STATES } from './profile.js';
import { FAMILY_DEFINITIONS, GROUP_PRODUCTS, productById, quoteFromCensus } from './corporateProduct.js';

// ---------- roles ----------
export const MANAGE = ['admin', 'operations_admin'];
export const FINANCE = ['admin', 'operations_admin', 'finance_manager'];
export const VIEW_ALL = ['admin', 'operations_admin', 'sales_manager', 'finance_manager', 'compliance_officer', 'auditor'];
export const CORP = ['corporate_admin', 'corporate_hr'];
export const SUPPORT_STAFF = ['admin', 'operations_admin', 'support_manager', 'support_agent'];
export const isCorp = (u) => CORP.includes(u?.role);
export const isReadOnly = (u) => READ_ONLY_ROLES.includes(u?.role);
export const SANDBOX_LABEL = 'SANDBOX — synthetic data for testing. Not a real insurance contract.';

/** Express guard: read-only oversight roles can never mutate anything in this module. */
export function readOnlyGuard(req, _res, next) {
  if (isReadOnly(req.user) && req.method !== 'GET') return next(forbidden('Read-only role: changes are not permitted'));
  return next();
}

/**
 * Resolves the employer the caller may act on. Corporate users are pinned to their own organisation
 * (another employer → 404); VHC staff with corporate visibility may pass any employerId.
 */
export function employerFor(user, employerId, { write = false } = {}) {
  let id = employerId || null;
  if (isCorp(user)) {
    id ||= user.orgId;
    if (id !== user.orgId) throw notFound('Employer not found');
  } else if (!VIEW_ALL.includes(user?.role)) {
    throw forbidden();
  }
  if (!id) throw bad('employerId is required');
  const emp = db.get('employers', id);
  if (!emp) throw notFound('Employer not found');
  if (write && isCorp(user) && ['Suspended', 'Ended'].includes(emp.status)) throw conflict(`This employer account is ${emp.status}; changes are disabled. Contact your VHC account manager.`);
  return emp;
}

/** Loads a record that carries employerId and checks the caller may see it (404 across tenants). */
export function scoped(user, collection, id, what = 'Record', opts = {}) {
  const rec = id ? db.get(collection, id) : null;
  if (!rec) throw notFound(`${what} not found`);
  try {
    employerFor(user, rec.employerId, opts);
  } catch (e) {
    if (e.status === 404) throw notFound(`${what} not found`);
    throw e;
  }
  return rec;
}

/** Employer ids visible to the caller (for list endpoints). */
export function visibleEmployerIds(user, employerId) {
  if (isCorp(user)) return [employerFor(user, employerId).id];
  if (!VIEW_ALL.includes(user?.role)) throw forbidden();
  return employerId ? [employerFor(user, employerId).id] : db.all('employers').map((e) => e.id);
}

// ---------- employer registry ----------
export const EMPLOYER_STATUSES = ['Prospect', 'Proposal', 'Contracted', 'Active', 'Suspended', 'Ended'];
const TRANSITIONS = {
  Prospect: ['Proposal', 'Ended'],
  Proposal: ['Contracted', 'Prospect', 'Ended'],
  Contracted: ['Active', 'Ended'],
  Active: ['Suspended', 'Ended'],
  Suspended: ['Active', 'Ended'],
  Ended: [],
};
export const ENTITY_TYPES = ['Private Limited', 'Public Limited', 'LLP', 'Partnership', 'Proprietorship', 'Trust / Society', 'Other'];
export const BILLING_ARRANGEMENTS = ['employer_paid', 'cost_shared', 'employee_voluntary_topup'];
export const BILLING_FREQUENCIES = ['annual', 'quarterly', 'monthly'];
export const EMPLOYMENT_TYPES = ['full_time', 'part_time', 'contract', 'intern'];

export const GSTIN_RE = /^(0[1-9]|[1-3][0-9]|97|99)[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const CIN_RE = /^[LU][0-9]{5}[A-Z]{2}[0-9]{4}[A-Z]{3}[0-9]{6}$/;
const LLPIN_RE = /^[A-Z]{3}-[0-9]{4}$/;
const PIN_RE = /^[1-9][0-9]{5}$/;

const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const list = (v) => (Array.isArray(v) ? v : String(v ?? '').split(',')).map((x) => str(x, 80)).filter(Boolean).slice(0, 50);

/** Validates employer input. `partial` (update) only checks the fields that are present. */
export function cleanEmployer(body = {}, { partial = false } = {}) {
  const f = {};
  const out = {};
  const has = (k) => !partial || body[k] !== undefined;
  if (has('name')) {
    out.name = str(body.name, 160);
    if (out.name.length < 2) f.name = 'Enter the registered name.';
  }
  if (has('legalName')) out.legalName = str(body.legalName, 200) || out.name || undefined;
  if (has('entityType')) {
    out.entityType = body.entityType || 'Private Limited';
    if (!ENTITY_TYPES.includes(out.entityType)) f.entityType = 'Select a legal entity type.';
  }
  if (body.cin !== undefined) {
    out.cin = str(body.cin, 21).toUpperCase();
    if (out.cin && !CIN_RE.test(out.cin)) f.cin = 'CIN must be 21 characters, e.g. U72200TN2020PTC123456.';
  }
  if (body.llpin !== undefined) {
    out.llpin = str(body.llpin, 8).toUpperCase();
    if (out.llpin && !LLPIN_RE.test(out.llpin)) f.llpin = 'LLPIN must look like AAA-1234.';
  }
  if (body.gstin !== undefined) {
    out.gstin = str(body.gstin, 15).toUpperCase();
    if (out.gstin && !GSTIN_RE.test(out.gstin)) f.gstin = 'GSTIN must be 15 characters: 2-digit state code, PAN, entity code, Z and a check character.';
  }
  if (body.industry !== undefined) out.industry = str(body.industry, 80);
  if (body.billing !== undefined) {
    const b = body.billing || {};
    out.billing = { contactName: str(b.contactName, 80), email: str(b.email, 120), address: str(b.address, 200), city: str(b.city, 60), state: str(b.state, 60), postalCode: str(b.postalCode, 6), poNumber: str(b.poNumber, 40) };
    if (out.billing.email && !cleanEmail(out.billing.email)) f['billing.email'] = 'Enter a valid billing email.';
    if (out.billing.postalCode && !PIN_RE.test(out.billing.postalCode)) f['billing.postalCode'] = 'PIN code must be 6 digits.';
    if (out.billing.state && !STATES.includes(out.billing.state)) f['billing.state'] = 'Select a state or union territory.';
  }
  if (body.hrContact !== undefined) {
    const h = body.hrContact || {};
    out.hrContact = { name: str(h.name, 80), email: str(h.email, 120), phone: str(h.phone, 20) };
    if (out.hrContact.email && !cleanEmail(out.hrContact.email)) f['hrContact.email'] = 'Enter a valid HR contact email.';
    if (out.hrContact.phone) {
      const m = normalizeMobile(out.hrContact.phone);
      if (!m) f['hrContact.phone'] = 'Enter a valid Indian mobile number.';
      else out.hrContact.phone = m;
    }
  }
  if (body.employeeCount !== undefined) {
    out.employeeCount = Number(body.employeeCount);
    if (!Number.isInteger(out.employeeCount) || out.employeeCount < 0 || out.employeeCount > 1000000) f.employeeCount = 'Employee population must be a whole number.';
  }
  if (body.locations !== undefined) out.locations = list(body.locations);
  if (body.insuranceRequirements !== undefined) out.insuranceRequirements = str(body.insuranceRequirements, 2000);
  if (body.existingArrangement !== undefined) {
    const x = body.existingArrangement || {};
    out.existingArrangement = { hasExisting: !!x.hasExisting, provider: str(x.provider, 120), renewalDate: x.renewalDate || '', notes: str(x.notes, 1000) };
    if (out.existingArrangement.renewalDate && !isValidDate(out.existingArrangement.renewalDate)) f['existingArrangement.renewalDate'] = 'Enter a valid date.';
  }
  if (body.desiredCoverage !== undefined) {
    const d = body.desiredCoverage || {};
    out.desiredCoverage = { sumInsured: d.sumInsured ? Number(d.sumInsured) : null, familyDefinition: d.familyDefinition || '', notes: str(d.notes, 1000) };
    if (out.desiredCoverage.familyDefinition && !FAMILY_DEFINITIONS[out.desiredCoverage.familyDefinition]) f['desiredCoverage.familyDefinition'] = 'Select a family definition.';
    if (out.desiredCoverage.sumInsured != null && (!Number.isSafeInteger(out.desiredCoverage.sumInsured) || out.desiredCoverage.sumInsured <= 0)) f['desiredCoverage.sumInsured'] = 'Sum insured must be in paise.';
  }
  if (body.contractValidity !== undefined) {
    const c = body.contractValidity || {};
    out.contractValidity = { from: c.from || '', to: c.to || '' };
    if (c.from && !isValidDate(c.from)) f['contractValidity.from'] = 'Enter a valid date.';
    if (c.to && !isValidDate(c.to)) f['contractValidity.to'] = 'Enter a valid date.';
    if (c.from && c.to && c.to < c.from) f['contractValidity.to'] = 'Contract end must be on or after the start.';
  }
  if (body.billingArrangement !== undefined) {
    out.billingArrangement = body.billingArrangement;
    if (!BILLING_ARRANGEMENTS.includes(out.billingArrangement)) f.billingArrangement = 'Select a billing arrangement.';
  }
  if (body.billingFrequency !== undefined) {
    out.billingFrequency = body.billingFrequency;
    if (!BILLING_FREQUENCIES.includes(out.billingFrequency)) f.billingFrequency = 'Select a billing frequency.';
  }
  if (body.accountOwnerId !== undefined) {
    out.accountOwnerId = body.accountOwnerId || null;
    const owner = out.accountOwnerId && db.get('users', out.accountOwnerId);
    if (out.accountOwnerId && (!owner || !['sales_manager', 'agent'].includes(owner.role) || !owner.active)) f.accountOwnerId = 'The account owner must be an active sales user.';
  }
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  if (Object.keys(f).length) throw unprocessable('Please correct the highlighted fields.', { fields: f });
  return out;
}

/** Requirements that must be met before an employer may move to a status. */
function statusProblems(emp, to) {
  const p = [];
  if (['Contracted', 'Active'].includes(to)) {
    if (!emp.gstin || !GSTIN_RE.test(emp.gstin)) p.push('A valid GSTIN is required');
    if (!emp.billing?.email) p.push('A billing email is required');
    if (!emp.hrContact?.email) p.push('An authorised HR contact is required');
    if (!emp.contractValidity?.from || !emp.contractValidity?.to) p.push('Contract validity dates are required');
  }
  if (to === 'Active' && !db.findOne('corporateContracts', (c) => c.employerId === emp.id && c.status === 'Active')) p.push('An active corporate contract is required');
  return p;
}

export function employerView(emp, { full = true } = {}) {
  const owner = emp.accountOwnerId ? db.get('users', emp.accountOwnerId) : null;
  const members = db.find('groupMembers', (m) => m.employerId === emp.id);
  return {
    ...emp,
    accountOwner: owner ? { id: owner.id, name: owner.name, role: owner.role } : null,
    rosterCount: members.filter((m) => m.status === 'Active').length,
    allowedTransitions: TRANSITIONS[emp.status] || [],
    statusHistory: full ? emp.statusHistory || [] : undefined,
  };
}

export function createEmployer(actor, body) {
  const data = cleanEmployer(body);
  if (db.findOne('employers', (e) => e.name.toLowerCase() === data.name.toLowerCase())) throw conflict('An employer with this registered name already exists');
  if (data.gstin && db.findOne('employers', (e) => e.gstin === data.gstin)) throw conflict('An employer with this GSTIN already exists');
  return tx(() => {
    const emp = db.insert('employers', {
      id: `emp_${String(nextSeq('employer')).padStart(5, '0')}`,
      sandbox: true, status: 'Prospect', locations: [], employeeCount: 0, billingArrangement: 'employer_paid', billingFrequency: 'annual',
      ...data, legalName: data.legalName || data.name,
      statusHistory: [{ at: now().toISOString(), status: 'Prospect', by: actor.name, role: actor.role, note: 'Employer created' }],
    });
    audit(actor, 'EMPLOYER_CREATED', 'employer', emp.id, { name: emp.name });
    return emp;
  });
}

export function updateEmployer(actor, emp, body, { billingOnly = false } = {}) {
  const allowed = billingOnly ? ['billing', 'hrContact'] : null;
  const input = allowed ? Object.fromEntries(Object.entries(body || {}).filter(([k]) => allowed.includes(k))) : body;
  const data = cleanEmployer(input, { partial: true });
  if (data.gstin && db.findOne('employers', (e) => e.gstin === data.gstin && e.id !== emp.id)) throw conflict('Another employer already uses this GSTIN');
  if (data.name && db.findOne('employers', (e) => e.id !== emp.id && e.name.toLowerCase() === data.name.toLowerCase())) throw conflict('Another employer already uses this name');
  return tx(() => {
    const changed = Object.keys(data);
    Object.assign(emp, data);
    db.touch(emp);
    audit(actor, 'EMPLOYER_UPDATED', 'employer', emp.id, { fields: changed });
    return emp;
  });
}

export function changeEmployerStatus(actor, emp, { status, note }) {
  if (!EMPLOYER_STATUSES.includes(status)) throw bad(`status must be one of ${EMPLOYER_STATUSES.join(', ')}`);
  if (!(TRANSITIONS[emp.status] || []).includes(status)) throw conflict(`Cannot move from ${emp.status} to ${status}`);
  if (['Suspended', 'Ended'].includes(status) && !str(note)) throw unprocessable('A reason is required to suspend or end an employer.', { fields: { note: 'Enter a reason.' } });
  const problems = statusProblems(emp, status);
  if (problems.length) throw unprocessable(`Cannot move to ${status}`, { problems });
  return tx(() => {
    const from = emp.status;
    emp.status = status;
    (emp.statusHistory ||= []).push({ at: now().toISOString(), from, status, by: actor.name, role: actor.role, note: str(note, 500) });
    db.touch(emp);
    audit(actor, 'EMPLOYER_STATUS_CHANGED', 'employer', emp.id, { from, to: status, note: str(note, 500) });
    for (const u of db.find('users', (x) => x.orgId === emp.id && CORP.includes(x.role) && x.status === 'Active')) {
      notify(u.id, 'Employer account status changed', `${emp.name} is now ${status}.`, { type: ['Suspended', 'Ended'].includes(status) ? 'warning' : 'info', link: '/corporate' });
    }
    return emp;
  });
}

// ---------- employer users ----------
export function employerUsers(emp) {
  return db.find('users', (u) => u.orgId === emp.id && CORP.includes(u.role)).map((u) => ({ ...publicUser(u), email: u.email }));
}

/**
 * Invites a corporate user (mirrors POST /admin/users): user created as Invited with the employer orgId
 * and an invite challenge; the invitee sets their own password via /accept-invite.
 */
export function inviteEmployerUser(actor, emp, body = {}) {
  const { firstName, lastName, email, role } = body;
  if (actor.role === 'corporate_admin' && role !== 'corporate_hr') throw forbidden('Corporate admins can invite HR users only');
  const fields = {};
  const fn = cleanName(firstName);
  if (!fn) fields.firstName = 'Enter a first name.';
  const ln = cleanName(lastName, { required: false });
  if (ln === null) fields.lastName = 'Use letters, spaces, apostrophes or hyphens.';
  const em = cleanEmail(email);
  if (!em) fields.email = 'Enter a valid email address.';
  if (!CORP.includes(role)) fields.role = 'Select Corporate admin or Corporate HR.';
  if (Object.keys(fields).length) throw unprocessable('Please correct the highlighted fields.', { fields });
  if (emp.status === 'Ended') throw conflict('Cannot invite users to an employer whose relationship has ended');
  if (db.findOne('users', (u) => u.emailLower === em.toLowerCase())) throw conflict('An account with this email already exists');
  return tx(() => {
    const name = displayName({ firstName: fn, lastName: ln });
    const rec = db.insert('users', {
      firstName: fn, lastName: ln, name, legalName: name, email: em, emailLower: em.toLowerCase(), emailVerified: false, mobile: '', mobileVerified: false,
      passwordHash: null, role, status: 'Invited', active: true, profile: {}, communicationPreference: 'email', invitedBy: actor.id, orgId: emp.id,
    });
    const { secret } = createChallenge({ subjectId: rec.id, purpose: 'invite', destination: rec.emailLower, kind: 'link' });
    audit(actor, 'USER_INVITED', 'user', rec.id, { email: maskEmail(em), role, orgId: emp.id });
    return { user: rec, token: secret };
  });
}

export function setEmployerUserActive(actor, emp, userId, active) {
  const u = db.get('users', userId);
  if (!u || u.orgId !== emp.id || !CORP.includes(u.role)) throw notFound('User not found');
  if (u.id === actor.id) throw conflict('You cannot deactivate your own account');
  if (actor.role === 'corporate_admin' && u.role !== 'corporate_hr') throw forbidden('Corporate admins can manage HR users only');
  return tx(() => {
    const before = u.active;
    u.active = !!active;
    if (!u.active) u.status = 'Disabled';
    else if (u.status === 'Disabled') u.status = u.passwordHash ? 'Active' : 'Invited';
    if (before !== u.active) revokeAllSessions(u.id, { reason: 'access_changed' });
    db.touch(u);
    audit(actor, 'USER_UPDATED', 'user', u.id, { before: { active: before }, after: { active: u.active }, orgId: emp.id });
    return u;
  });
}

// ---------- corporate contracts ----------
export const CONTRACT_SERVICES = ['group_health', 'wellness', 'benefits_administration'];

export function createContract(actor, emp, body = {}) {
  const f = {};
  const { startDate, endDate } = body;
  if (!isValidDate(startDate)) f.startDate = 'Enter a valid start date.';
  if (!isValidDate(endDate)) f.endDate = 'Enter a valid end date.';
  if (isValidDate(startDate) && isValidDate(endDate) && endDate <= startDate) f.endDate = 'End must be after start.';
  const services = (Array.isArray(body.services) && body.services.length ? body.services : ['group_health']).filter((s) => CONTRACT_SERVICES.includes(s));
  if (!services.length) f.services = 'Select at least one contracted service.';
  const fee = body.serviceFeePerMemberMonth == null || body.serviceFeePerMemberMonth === '' ? 0 : Number(body.serviceFeePerMemberMonth);
  if (!Number.isSafeInteger(fee) || fee < 0) f.serviceFeePerMemberMonth = 'Service fee must be a whole number of paise.';
  const paymentTermsDays = body.paymentTermsDays == null ? 30 : Number(body.paymentTermsDays);
  if (!Number.isInteger(paymentTermsDays) || paymentTermsDays < 0 || paymentTermsDays > 120) f.paymentTermsDays = 'Payment terms must be 0–120 days.';
  if (Object.keys(f).length) throw unprocessable('Please correct the highlighted fields.', { fields: f });
  if (['Ended', 'Prospect'].includes(emp.status)) throw conflict(`Contracts cannot be created while the employer is ${emp.status}`);
  return tx(() => {
    const c = db.insert('corporateContracts', {
      contractNumber: `CC-${today().slice(0, 4)}-${String(nextSeq('corpContract')).padStart(4, '0')}`,
      employerId: emp.id, startDate, endDate, services, serviceFeePerMemberMonth: fee, paymentTermsDays,
      billingArrangement: BILLING_ARRANGEMENTS.includes(body.billingArrangement) ? body.billingArrangement : emp.billingArrangement || 'employer_paid',
      status: body.signed ? 'Active' : 'Draft', signedAt: body.signed ? now().toISOString() : null, signedBy: body.signed ? actor.name : null,
      notes: str(body.notes, 1000), sandbox: true,
    });
    audit(actor, 'CORPORATE_CONTRACT_CREATED', 'corporateContract', c.id, { employerId: emp.id, status: c.status });
    return c;
  });
}

export function setContractStatus(actor, c, status) {
  const allowed = { Draft: ['Active', 'Ended'], Active: ['Ended'], Ended: [] };
  if (!(allowed[c.status] || []).includes(status)) throw conflict(`Cannot move contract from ${c.status} to ${status}`);
  return tx(() => {
    const from = c.status;
    c.status = status;
    if (status === 'Active') Object.assign(c, { signedAt: now().toISOString(), signedBy: actor.name });
    db.touch(c);
    audit(actor, 'CORPORATE_CONTRACT_STATUS', 'corporateContract', c.id, { from, to: status });
    return c;
  });
}

export const activeContract = (employerId, on = today()) =>
  db.findOne('corporateContracts', (c) => c.employerId === employerId && c.status === 'Active' && c.startDate <= on && c.endDate >= on)
  || db.findOne('corporateContracts', (c) => c.employerId === employerId && c.status === 'Active');

// ---------- group quotations ----------
/** Census from the roster: active employees + active dependents allowed by the family definition, ages at startDate. */
export function rosterCensus(employerId, product, familyDefinition, startDate) {
  const rels = FAMILY_DEFINITIONS[familyDefinition].relationships;
  const counts = Object.fromEntries(product.ageBands.map((b) => [b.band, 0]));
  const add = (dob) => {
    const age = ageOn(dob, startDate);
    const band = product.ageBands.find((b) => age >= b.min && age <= b.max);
    if (band) counts[band.band] += 1;
  };
  for (const m of db.find('groupMembers', (x) => x.employerId === employerId && x.status === 'Active')) {
    add(m.dob);
    for (const d of db.find('groupDependents', (x) => x.memberId === m.id && x.status === 'Active' && rels.includes(x.relationship))) add(d.dob);
  }
  return Object.entries(counts).map(([band, lives]) => ({ band, lives }));
}

export function createQuote(actor, emp, body = {}) {
  const product = productById(body.productId || GROUP_PRODUCTS[0].id);
  if (!product) throw unprocessable('Select a group product.', { fields: { productId: 'Unknown product.' } });
  const sumInsured = Number(body.sumInsured);
  if (!product.sumInsuredOptions.includes(sumInsured)) throw unprocessable('Select a sum insured option.', { fields: { sumInsured: 'Not offered on this product.' } });
  const familyDefinition = body.familyDefinition || 'ESC';
  if (!FAMILY_DEFINITIONS[familyDefinition]) throw unprocessable('Select a family definition.', { fields: { familyDefinition: 'Unknown family definition.' } });
  const startDate = body.startDate || addDays(today(), 30);
  if (!isValidDate(startDate)) throw unprocessable('Enter a valid start date.', { fields: { startDate: 'Enter a valid date.' } });
  const census = body.fromRoster ? rosterCensus(emp.id, product, familyDefinition, startDate) : body.census;
  if (!Array.isArray(census) || !census.length) throw unprocessable('Provide the census (lives per age band) or use the roster.', { fields: { census: 'Required.' } });
  let q;
  try {
    q = quoteFromCensus(product, { sumInsured, census });
  } catch (e) {
    throw unprocessable(e.message, { fields: { census: e.message } });
  }
  if (!q.lives) throw unprocessable('The census has no lives.', { fields: { census: 'At least one life is required.' } });
  return tx(() => {
    const rec = db.insert('groupQuotes', {
      quoteNumber: `GQ-${String(nextSeq('groupQuote')).padStart(6, '0')}`, employerId: emp.id, productId: product.id, productName: product.name,
      insurerId: product.insurerId, sumInsured, familyDefinition, startDate, census: census.map((c) => ({ band: c.band, lives: Number(c.lives) })), ...q,
      source: body.fromRoster ? 'roster' : 'census', renewalOf: body.renewalOf || null, validUntil: addDays(today(), 30), createdBy: actor.name, sandbox: true, label: SANDBOX_LABEL,
    });
    audit(actor, 'GROUP_QUOTE_CREATED', 'groupQuote', rec.id, { employerId: emp.id, total: rec.total, lives: rec.lives });
    return rec;
  });
}
