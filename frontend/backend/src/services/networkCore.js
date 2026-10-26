// Network module core: provider registry (hospitals, clinics, diagnostic/imaging centres, telehealth),
// onboarding pipeline, verification of credentials, and insurer × hospital × product cashless networks.
//
// The `hospitals` collection holds every provider organisation (the hospital record *is* the org that
// hospital users belong to). Real hospital chains appear only as admin-side candidate prospects
// (`candidate: true`), never in public search and never activated in the sandbox.
//
// Cashless eligibility is never implied by a general VHC contract: it is resolved from `hospitalNetworks`
// records scoped to insurer × hospital × product (all products, or listed plan ids) × services × dates.
// The legacy boolean `hospital.network` (used by the original claims code) mirrors whether the hospital
// has an in-effect all-products cashless record for the sandbox insurer.
import { db, newId } from '../db.js';
import { now, today } from '../clock.js';
import { addDays } from '../utils/dates.js';
import { bad, conflict, notFound, unprocessable } from '../utils/errors.js';
import { audit } from './audit.js';
import { SANDBOX_INSURER_ID } from './insurerHub.js';

export const REGISTRY_WRITE = ['admin', 'operations_admin'];
export const REGISTRY_READ = [...REGISTRY_WRITE, 'compliance_officer', 'auditor'];
export const HOSPITAL_ROLES = ['hospital_admin', 'hospital_staff'];
export const TPA_ROLES = ['tpa_admin', 'tpa_agent'];

export const PROVIDER_TYPES = ['hospital', 'clinic', 'diagnostic_centre', 'imaging_centre', 'telehealth'];
export const STAGES = ['Prospect', 'Credential Verification', 'Contracting', 'Active', 'Suspended', 'Terminated'];
const NEXT = {
  Prospect: ['Credential Verification', 'Terminated'],
  'Credential Verification': ['Contracting', 'Prospect', 'Terminated'],
  Contracting: ['Active', 'Credential Verification', 'Terminated'],
  Active: ['Suspended', 'Terminated'],
  Suspended: ['Active', 'Terminated'],
  Terminated: [],
};
export const CANDIDATE_LABEL = 'Candidate — not a VHC partner';

export const NETWORK_STATUSES = ['active', 'restricted', 'excluded'];
/** Cashless service lines a network record can be limited to (empty list = all lines). */
export const NETWORK_SERVICES = ['inpatient', 'daycare', 'maternity', 'opd', 'diagnostics', 'health_check'];
export const NETWORK_STATUS_TEXT = {
  active: 'Cashless available',
  restricted: 'Cashless not available for this product/service — reimbursement may still be possible under your policy terms',
  excluded: 'Excluded by the insurer — check your policy wording before treatment (claims may not be payable except as the policy allows)',
  not_in_network: 'Not in this insurer\'s cashless network — reimbursement may still be possible under your policy terms',
};
export const DIRECTORY_DISCLAIMER = 'Listing on VHC does not guarantee cashless approval. Cashless treatment is always subject to the insurer\'s (or its TPA\'s) pre-authorisation, your policy terms and the network status on the date of admission. Network information is shown as last verified; confirm with the hospital insurance desk before admission.';

// ---------- helpers ----------
const s = (v) => String(v ?? '').trim();
const lc = (v) => s(v).toLowerCase();
const list = (v) => (Array.isArray(v) ? v : s(v).split(',')).map((x) => s(x)).filter(Boolean);
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '') && !Number.isNaN(new Date(`${v}T00:00:00Z`).getTime());
export const actorRef = (u) => ({ id: u?.id || 'system', name: u?.name || 'System', role: u?.role || 'system' });

export const isCandidate = (h) => !!h?.candidate;
export const stageOf = (h) => h?.onboarding?.stage || (h?.active ? 'Active' : 'Prospect');
/** Visible to the public directory and bookable. */
export const isPublicProvider = (h) => !!h && !h.candidate && h.active !== false && stageOf(h) === 'Active' && h.publishable !== false;

/** Insurers that may be named publicly (never candidate/prospect insurers). */
export const publicInsurers = () => db.find('insurers', (i) => i.publishable && i.status === 'Active');
export const isPublicInsurer = (id) => publicInsurers().some((i) => i.id === id);
export const insurerName = (id) => db.get('insurers', id)?.name || id;
export const planName = (id) => db.get('plans', id)?.name || id;

export function directionsUrl(h) {
  const q = [h.name, h.address, h.city, h.state, h.postalCode].filter(Boolean).join(', ');
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(q)}`;
}

export function getProvider(id) {
  const h = db.get('hospitals', id);
  if (!h) throw notFound('Provider not found');
  return h;
}

// ---------- cashless networks ----------
const inEffect = (r, date) => r.effectiveFrom <= date && (!r.effectiveTo || r.effectiveTo >= date);
const SEVERITY = { excluded: 3, restricted: 2, active: 1 };

/**
 * Resolves cashless status for a hospital with one insurer, optionally for a plan, a service line and a date.
 * Plan-specific records override the insurer's all-products record; within a level the most restrictive wins.
 * Returns { eligible, status, record, lastVerifiedAt, source, scope, text, planSpecific }.
 */
export function cashlessStatus({ hospitalId, insurerId, planId, service, date = today() }) {
  const h = db.get('hospitals', hospitalId);
  const base = { insurerId, insurerName: insurerName(insurerId), planId: planId || null, planName: planId ? planName(planId) : null, date };
  if (!h || h.candidate || h.active === false || ['Suspended', 'Terminated'].includes(stageOf(h))) {
    return { ...base, eligible: false, status: 'not_in_network', text: NETWORK_STATUS_TEXT.not_in_network, record: null };
  }
  const all = db.find('hospitalNetworks', (r) => r.hospitalId === hospitalId && r.insurerId === insurerId);
  const live = all.filter((r) => inEffect(r, date) && (!service || !r.services?.length || r.services.includes(service)));
  const planRecs = planId ? live.filter((r) => r.scope === 'plans' && r.planIds?.includes(planId)) : [];
  const allRecs = live.filter((r) => r.scope === 'all_products');
  const pool = planRecs.length ? planRecs : allRecs;
  const planSpecific = planId ? [] : live.filter((r) => r.scope === 'plans').map((r) => ({ planIds: r.planIds, planNames: r.planIds.map(planName), status: r.status }));
  if (!pool.length) {
    const expired = all.some((r) => r.effectiveTo && r.effectiveTo < date);
    return { ...base, eligible: false, status: 'not_in_network', text: expired ? 'The cashless arrangement with this insurer has expired' : NETWORK_STATUS_TEXT.not_in_network, record: null, planSpecific, expired };
  }
  const rec = [...pool].sort((a, b) => SEVERITY[b.status] - SEVERITY[a.status])[0];
  return {
    ...base, eligible: rec.status === 'active', status: rec.status, text: NETWORK_STATUS_TEXT[rec.status],
    scope: rec.scope, services: rec.services || [], lastVerifiedAt: rec.verifiedAt || null, source: rec.verificationSource || null,
    effectiveFrom: rec.effectiveFrom, effectiveTo: rec.effectiveTo || null, recordId: rec.id, note: rec.publicNote || null, planSpecific,
    label: rec.status === 'active'
      ? `Cashless with ${insurerName(insurerId)} for ${planId ? planName(planId) : rec.scope === 'all_products' ? 'all its products' : rec.planIds.map(planName).join(', ')}${rec.verifiedAt ? ` — last verified ${rec.verifiedAt.slice(0, 10)}` : ''}`
      : `${insurerName(insurerId)}: ${rec.status}${planId ? ` for ${planName(planId)}` : ''}`,
  };
}

/** Keeps the legacy boolean `hospital.network` in sync (sandbox insurer, all products, today). */
export function syncLegacyNetworkFlag(hospitalId) {
  const h = db.get('hospitals', hospitalId);
  if (!h) return null;
  // The original claims workflow treats the flag as "in-patient cashless", so service-limited records
  // (e.g. diagnostics only) do not set it.
  const want = !h.candidate && cashlessStatus({ hospitalId, insurerId: SANDBOX_INSURER_ID, service: 'inpatient', date: today() }).eligible;
  if (h.network !== want) {
    h.network = want;
    db.touch(h);
  }
  return want;
}
export const syncAllLegacyFlags = () => db.all('hospitals').reduce((n, h) => {
  const before = h.network;
  syncLegacyNetworkFlag(h.id);
  return n + (before !== h.network ? 1 : 0);
}, 0);

function cleanNetwork(b, existing = {}) {
  const out = {};
  const v = { ...existing };
  for (const [k, val] of Object.entries(b)) if (val !== undefined) v[k] = val;
  if (!db.get('insurers', v.insurerId)) throw unprocessable('Select an insurer');
  if (db.get('insurers', v.insurerId).status === 'Prospect') throw unprocessable('Cashless networks can only be recorded for insurers with an active agreement (not candidates).');
  const h = db.get('hospitals', v.hospitalId);
  if (!h) throw unprocessable('Select a provider');
  if (h.candidate) throw unprocessable(`${h.name} is a ${CANDIDATE_LABEL.toLowerCase()}; no network record can be created.`);
  out.insurerId = v.insurerId;
  out.hospitalId = v.hospitalId;
  out.scope = v.scope === 'plans' ? 'plans' : 'all_products';
  out.planIds = out.scope === 'plans' ? list(v.planIds) : [];
  if (out.scope === 'plans') {
    if (!out.planIds.length) throw unprocessable('Select at least one plan, or use "all products of this insurer"');
    for (const pid of out.planIds) if (db.get('plans', pid)?.insurerId !== out.insurerId) throw unprocessable(`Plan ${pid} is not a product of this insurer`);
  }
  out.services = list(v.services);
  for (const x of out.services) if (!NETWORK_SERVICES.includes(x)) throw unprocessable(`Unknown service line ${x}`);
  if (!NETWORK_STATUSES.includes(v.status)) throw unprocessable('Status must be active, restricted or excluded');
  out.status = v.status;
  if (!isDate(v.effectiveFrom)) throw unprocessable('Effective-from date is required (YYYY-MM-DD)');
  if (v.effectiveTo && !isDate(v.effectiveTo)) throw unprocessable('Effective-to must be a date (YYYY-MM-DD)');
  if (v.effectiveTo && v.effectiveTo < v.effectiveFrom) throw unprocessable('Effective-to cannot be before effective-from');
  out.effectiveFrom = v.effectiveFrom;
  out.effectiveTo = v.effectiveTo || null;
  out.verificationSource = s(v.verificationSource) || null;
  out.publicNote = s(v.publicNote) || null;
  out.internalNote = s(v.internalNote) || null;
  return out;
}

export function createNetworkRecord(body, actor) {
  const rec = cleanNetwork(body || {});
  const created = db.insert('hospitalNetworks', {
    id: newId('hnw'),
    ...rec, verifiedAt: rec.verificationSource ? now().toISOString() : null, verifiedBy: rec.verificationSource ? actor.name : null,
    history: [{ at: now().toISOString(), by: actor.name, role: actor.role, action: 'created', status: rec.status }],
  });
  audit(actor, 'HOSPITAL_NETWORK_CREATED', 'hospitalNetwork', created.id, { insurerId: rec.insurerId, hospitalId: rec.hospitalId, scope: rec.scope, planIds: rec.planIds, status: rec.status });
  syncLegacyNetworkFlag(rec.hospitalId);
  return created;
}

export function updateNetworkRecord(rec, body, actor) {
  const next = cleanNetwork({ ...body, insurerId: rec.insurerId, hospitalId: rec.hospitalId }, rec);
  const before = { status: rec.status, effectiveFrom: rec.effectiveFrom, effectiveTo: rec.effectiveTo, planIds: rec.planIds, services: rec.services };
  Object.assign(rec, next);
  rec.history.push({ at: now().toISOString(), by: actor.name, role: actor.role, action: 'updated', status: rec.status, note: s(body.note) || null });
  db.touch(rec);
  audit(actor, 'HOSPITAL_NETWORK_UPDATED', 'hospitalNetwork', rec.id, { before, after: { status: rec.status, effectiveFrom: rec.effectiveFrom, effectiveTo: rec.effectiveTo, planIds: rec.planIds, services: rec.services } });
  syncLegacyNetworkFlag(rec.hospitalId);
  return rec;
}

export function verifyNetworkRecord(rec, { source }, actor) {
  if (!s(source)) throw bad('Record the verification source (e.g. insurer network file reference)');
  rec.verifiedAt = now().toISOString();
  rec.verifiedBy = actor.name;
  rec.verificationSource = s(source);
  rec.history.push({ at: rec.verifiedAt, by: actor.name, role: actor.role, action: 'verified', status: rec.status, note: rec.verificationSource });
  db.touch(rec);
  audit(actor, 'HOSPITAL_NETWORK_VERIFIED', 'hospitalNetwork', rec.id, { source: rec.verificationSource });
  return rec;
}

export const networkView = (r) => ({
  ...r, insurerName: insurerName(r.insurerId), hospitalName: db.get('hospitals', r.hospitalId)?.name || r.hospitalId,
  planNames: (r.planIds || []).map(planName),
  inEffect: inEffect(r, today()), expired: !!(r.effectiveTo && r.effectiveTo < today()),
});

/**
 * Reflects a change of the legacy boolean (old admin hospital editor) into network records for the
 * sandbox insurer, so the old screen and the network module never disagree.
 */
export function applyLegacyNetworkFlag(h, wanted, actor) {
  const t = today();
  const recs = db.find('hospitalNetworks', (r) => r.hospitalId === h.id && r.insurerId === SANDBOX_INSURER_ID && r.scope === 'all_products' && inEffect(r, t));
  if (wanted && !recs.some((r) => r.status === 'active') && !h.candidate) {
    const off = recs.find((r) => r.status !== 'active');
    if (off) updateNetworkRecord(off, { status: 'active', note: 'Re-enabled via hospital network flag' }, actor);
    else createNetworkRecord({ insurerId: SANDBOX_INSURER_ID, hospitalId: h.id, scope: 'all_products', status: 'active', effectiveFrom: t, verificationSource: 'Admin hospital editor (legacy network flag)' }, actor);
  } else if (!wanted) {
    for (const r of recs.filter((x) => x.status === 'active')) updateNetworkRecord(r, { status: 'restricted', note: 'Cashless withdrawn via hospital network flag' }, actor);
  }
  syncLegacyNetworkFlag(h.id);
}

// ---------- provider registry ----------
const VERIFIABLE = ['registration', 'bedCapacity', 'emergency', 'icu'];

function cleanLicence(l, prev) {
  const out = { type: s(l.type) || 'Clinical establishment licence', number: s(l.number), authority: s(l.authority), validFrom: isDate(l.validFrom) ? l.validFrom : null, validTo: isDate(l.validTo) ? l.validTo : null };
  const same = prev && prev.number === out.number && prev.authority === out.authority && prev.validTo === out.validTo;
  return { ...out, verified: same ? !!prev.verified : false, verifiedAt: same ? prev.verifiedAt || null : null, verifiedBy: same ? prev.verifiedBy || null : null, source: same ? prev.source || null : null };
}
function cleanAccreditation(a, prev) {
  const out = { body: s(a.body).toUpperCase() || 'NABH', level: s(a.level) || null, certificateNo: s(a.certificateNo) || null, validTo: isDate(a.validTo) ? a.validTo : null, claimed: true };
  const same = prev && prev.body === out.body && prev.certificateNo === out.certificateNo && prev.validTo === out.validTo;
  return { ...out, verified: same ? !!prev.verified : false, verifiedAt: same ? prev.verifiedAt || null : null, source: same ? prev.source || null : null };
}

/**
 * Applies editable profile fields. Fields that carry a "verified" flag go back to pending verification when
 * their value changes. Returns the list of fields reset to pending.
 */
export function applyProviderFields(h, b, { allowed } = {}) {
  const pending = [];
  const can = (k) => b[k] !== undefined && (!allowed || allowed.includes(k));
  if (can('name')) { if (!s(b.name)) throw unprocessable('Name is required'); h.name = s(b.name); }
  if (can('legalName')) h.legalName = s(b.legalName);
  if (can('providerType')) { if (!PROVIDER_TYPES.includes(b.providerType)) throw unprocessable('Unknown provider type'); h.providerType = b.providerType; }
  for (const k of ['address', 'city', 'state', 'phone', 'email', 'website']) if (can(k)) h[k] = s(b[k]);
  if (can('postalCode')) { if (!/^\d{6}$/.test(s(b.postalCode))) throw unprocessable('PIN code must be 6 digits'); h.postalCode = s(b.postalCode); }
  if (can('lat') || can('lng')) {
    const lat = Number(b.lat ?? h.lat), lng = Number(b.lng ?? h.lng);
    if (!(lat >= 6 && lat <= 38 && lng >= 68 && lng <= 98)) throw unprocessable('Latitude/longitude must be within India');
    h.lat = lat; h.lng = lng;
  }
  for (const k of ['specialties', 'diagnostics', 'supportedServices']) if (can(k)) h[k] = list(b[k]);
  if (can('contacts')) h.contacts = (Array.isArray(b.contacts) ? b.contacts : []).map((c) => ({ name: s(c.name), role: s(c.role), phone: s(c.phone), email: s(c.email) })).filter((c) => c.name);
  if (can('insuranceDesk')) {
    const d = b.insuranceDesk || {};
    h.insuranceDesk = { name: s(d.name), phone: s(d.phone), email: s(d.email), hours: s(d.hours) };
  }
  if (can('registration')) {
    const r = b.registration || {}, prev = h.registration || {};
    const next = { number: s(r.number), authority: s(r.authority), validFrom: isDate(r.validFrom) ? r.validFrom : null, validTo: isDate(r.validTo) ? r.validTo : null };
    const changed = ['number', 'authority', 'validTo'].some((k) => (prev[k] || null) !== (next[k] || null));
    h.registration = { ...next, verified: changed ? false : !!prev.verified, verifiedAt: changed ? null : prev.verifiedAt || null, source: changed ? null : prev.source || null };
    if (changed && prev.verified) pending.push('registration');
  }
  if (can('licences')) {
    const prev = h.licences || [];
    h.licences = (Array.isArray(b.licences) ? b.licences : []).map((l, i) => cleanLicence(l, prev.find((p) => p.number === s(l.number)) || prev[i]));
    if (h.licences.some((l, i) => !l.verified && (prev.find((p) => p.number === l.number) || prev[i])?.verified)) pending.push('licences');
  }
  if (can('accreditations')) {
    const prev = h.accreditations || [];
    h.accreditations = (Array.isArray(b.accreditations) ? b.accreditations : []).map((a) => cleanAccreditation(a, prev.find((p) => p.body === s(a.body).toUpperCase())));
    if (h.accreditations.some((a) => !a.verified && prev.find((p) => p.body === a.body)?.verified)) pending.push('accreditations');
  }
  if (can('bedCapacity')) {
    const total = Number(b.bedCapacity?.total ?? b.bedCapacity);
    if (!Number.isInteger(total) || total < 0) throw unprocessable('Bed capacity must be a whole number');
    if (h.bedCapacity?.total !== total) {
      if (h.bedCapacity?.verified) pending.push('bedCapacity');
      h.bedCapacity = { total, verified: false, verifiedAt: null, source: null };
    }
  }
  for (const k of ['emergency', 'icu']) {
    if (!can(k)) continue;
    const v = b[k] || {};
    const next = k === 'icu' ? { available: !!v.available, beds: Number.isInteger(Number(v.beds)) ? Number(v.beds) : 0 } : { available: !!v.available, hours: s(v.hours) || (v.available ? '24x7' : '') };
    const prev = h[k] || {};
    const changed = prev.available !== next.available || (k === 'icu' && prev.beds !== next.beds);
    if (changed) {
      if (prev.verified) pending.push(k);
      h[k] = { ...next, verified: false, verifiedAt: null, source: null };
    }
  }
  if (can('branches')) {
    h.branches = (Array.isArray(b.branches) ? b.branches : []).map((x, i) => ({
      id: s(x.id) || `${h.id}_br${i + 1}`, name: s(x.name), address: s(x.address), city: s(x.city), postalCode: s(x.postalCode),
      facilities: list(x.facilities), active: x.active !== false,
    })).filter((x) => x.name);
  }
  if (can('qualityRecords')) h.qualityRecords = (Array.isArray(b.qualityRecords) ? b.qualityRecords : []).map((q) => ({ at: isDate(q.at) ? q.at : today(), type: s(q.type), summary: s(q.summary), outcome: s(q.outcome) }));
  if (can('integration')) {
    const v = b.integration || {};
    h.integration = { status: ['Not started', 'In progress', 'Testing', 'Live (sandbox)', 'Not applicable'].includes(v.status) ? v.status : 'Not started', protocol: s(v.protocol) || null, notes: s(v.notes) || null };
  }
  if (pending.length) {
    h.pendingVerification = [...new Set([...(h.pendingVerification || []), ...pending])];
    h.verificationStatus = 'pending verification';
  }
  db.touch(h);
  return pending;
}

/** Marks a credential/attribute verified (admin/operations). target: registration | licence:<n> | accreditation:<n> | bedCapacity | emergency | icu. */
export function verifyProviderField(h, { target, source }, actor) {
  if (!s(source)) throw bad('Record the verification source (e.g. registry lookup reference or inspection report)');
  const at = now().toISOString();
  const mark = (o) => Object.assign(o, { verified: true, verifiedAt: at, verifiedBy: actor.name, source: s(source) });
  let field = target;
  if (VERIFIABLE.includes(target)) {
    if (!h[target]) throw unprocessable(`${target} has not been provided`);
    if (target === 'registration' && !h.registration.number) throw unprocessable('Registration number is missing');
    mark(h[target]);
  } else if (/^licence:\d+$/.test(target || '')) {
    const l = h.licences?.[Number(target.split(':')[1])];
    if (!l) throw notFound('Licence not found');
    mark(l);
    field = 'licences';
  } else if (/^accreditation:\d+$/.test(target || '')) {
    const a = h.accreditations?.[Number(target.split(':')[1])];
    if (!a) throw notFound('Accreditation not found');
    if (a.validTo && a.validTo < today()) throw unprocessable('The accreditation certificate has expired; it cannot be marked verified');
    mark(a);
    field = 'accreditations';
  } else throw bad('Unknown verification target');
  const stillPending = (h.pendingVerification || []).filter((p) => p !== field || (field === 'licences' && h.licences.some((l) => !l.verified)) || (field === 'accreditations' && h.accreditations.some((a) => !a.verified)));
  h.pendingVerification = stillPending;
  h.verificationStatus = stillPending.length ? 'pending verification' : 'verified';
  db.touch(h);
  audit(actor, 'PROVIDER_FIELD_VERIFIED', 'hospital', h.id, { target, source: s(source) });
  return h;
}

export const verifiedAccreditations = (h, date = today()) => (h.accreditations || []).filter((a) => a.verified && (!a.validTo || a.validTo >= date));

/** Onboarding gate checks for moving to `to`. Returns a list of unmet requirements. */
export function stageGaps(h, to) {
  const gaps = [];
  const t = today();
  if (to === 'Credential Verification') {
    if (!s(h.legalName)) gaps.push('Legal name');
    if (!s(h.registration?.number)) gaps.push('Registration number');
    if (!s(h.address) || !s(h.city) || !/^\d{6}$/.test(h.postalCode || '')) gaps.push('Full address with PIN code');
    if (!h.contacts?.length) gaps.push('At least one contact');
  }
  if (to === 'Contracting' || to === 'Active') {
    if (!h.registration?.verified) gaps.push('Registration verified');
    if (h.registration?.validTo && h.registration.validTo < t) gaps.push('Registration valid (not expired)');
    if (!h.licences?.length) gaps.push('At least one licence recorded');
    if (h.licences?.some((l) => !l.verified)) gaps.push('All licences verified');
    if (h.licences?.some((l) => l.validTo && l.validTo < t)) gaps.push('All licences valid (not expired)');
  }
  if (to === 'Active') {
    if (h.candidate) gaps.push(`${CANDIDATE_LABEL}: candidates cannot be activated`);
    const live = db.findOne('providerContracts', (c) => c.hospitalId === h.id && c.status === 'active' && c.effectiveFrom <= t && c.effectiveTo >= t);
    if (!live) gaps.push('An approved provider contract in effect');
  }
  return gaps;
}

export function changeStage(h, { stage, note }, actor) {
  const from = stageOf(h);
  if (!STAGES.includes(stage)) throw bad('Unknown onboarding stage');
  if (!NEXT[from].includes(stage)) throw conflict(`Cannot move from ${from} to ${stage}`);
  if (['Suspended', 'Terminated'].includes(stage) && !s(note)) throw bad(`A reason is required to mark the provider ${stage.toLowerCase()}`);
  if (stage === 'Terminated' && actor.role !== 'admin') throw conflict('Only an administrator can terminate a provider');
  const gaps = stageGaps(h, stage);
  if (gaps.length) throw unprocessable(`Requirements not met for ${stage}: ${gaps.join('; ')}`, { gaps });
  h.onboarding ||= { stage: from, history: [] };
  h.onboarding.stage = stage;
  h.onboarding.history.push({ at: now().toISOString(), from, status: stage, by: actor.name, role: actor.role, note: s(note) || null });
  h.active = stage === 'Active';
  db.touch(h);
  syncLegacyNetworkFlag(h.id);
  audit(actor, 'PROVIDER_STAGE_CHANGED', 'hospital', h.id, { from, to: stage, note: s(note) || null });
  return h;
}

export function createProvider(b, actor) {
  if (!s(b.name)) throw unprocessable('Name is required');
  const providerType = PROVIDER_TYPES.includes(b.providerType) ? b.providerType : 'hospital';
  const h = db.insert('hospitals', {
    id: newId('prv'), name: s(b.name), legalName: s(b.legalName), providerType, address: '', city: '', state: '', postalCode: '', phone: '', email: '',
    specialties: [], network: false, active: false, publishable: true, sandbox: true, candidate: false,
    registration: { number: '', authority: '', validFrom: null, validTo: null, verified: false }, licences: [], accreditations: [],
    contacts: [], insuranceDesk: null, diagnostics: [], supportedServices: [], branches: [], qualityRecords: [],
    emergency: { available: false, verified: false }, icu: { available: false, beds: 0, verified: false }, bedCapacity: null,
    integration: { status: 'Not started', protocol: null, notes: null }, pendingVerification: [], verificationStatus: 'unverified',
    onboarding: { stage: 'Prospect', history: [{ at: now().toISOString(), from: null, status: 'Prospect', by: actor.name, role: actor.role, note: 'Provider added' }] },
  });
  applyProviderFields(h, { ...b, name: undefined, providerType: undefined });
  audit(actor, 'PROVIDER_CREATED', 'hospital', h.id, { name: h.name, providerType });
  return h;
}

// ---------- views ----------
/** Public directory view: only verified attributes are presented as verified; no internal fields. */
export function publicProvider(h, { date = today() } = {}) {
  const networks = publicInsurers().map((ins) => {
    const st = cashlessStatus({ hospitalId: h.id, insurerId: ins.id, date });
    const recs = db.find('hospitalNetworks', (r) => r.hospitalId === h.id && r.insurerId === ins.id && inEffect(r, date));
    if (!recs.length) return null;
    return {
      insurerId: ins.id, insurerName: ins.name, sandbox: !!ins.sandbox, allProducts: st.status !== 'not_in_network' ? { status: st.status, lastVerifiedAt: st.lastVerifiedAt, services: st.services } : null,
      plans: recs.filter((r) => r.scope === 'plans').map((r) => ({ planIds: r.planIds, planNames: r.planIds.map(planName), status: r.status, services: r.services, lastVerifiedAt: r.verifiedAt, note: r.publicNote })),
    };
  }).filter(Boolean);
  return {
    id: h.id, name: h.name, providerType: h.providerType || 'hospital', sandbox: h.sandbox !== false,
    address: h.address, city: h.city, state: h.state, postalCode: h.postalCode, lat: h.lat ?? null, lng: h.lng ?? null,
    phone: h.phone, email: h.email, specialties: h.specialties || [], diagnostics: h.diagnostics || [], supportedServices: h.supportedServices || [],
    emergency: { available: !!h.emergency?.available, verified: !!h.emergency?.verified, hours: h.emergency?.hours || null },
    icu: { available: !!h.icu?.available, verified: !!h.icu?.verified },
    bedCapacity: h.bedCapacity?.verified ? { total: h.bedCapacity.total, verifiedAt: h.bedCapacity.verifiedAt } : null,
    accreditations: verifiedAccreditations(h, date).map((a) => ({ body: a.body, level: a.level, validTo: a.validTo, verifiedAt: a.verifiedAt, source: a.source })),
    insuranceDesk: h.insuranceDesk || null,
    branches: (h.branches || []).filter((b) => b.active !== false).map((b) => ({ id: b.id, name: b.name, address: b.address, city: b.city, postalCode: b.postalCode, facilities: b.facilities })),
    directionsUrl: directionsUrl(h), network: !!h.network, networks,
  };
}

/** Full internal view for the registry. */
export function registryView(h) {
  const contracts = db.find('providerContracts', (c) => c.hospitalId === h.id);
  return {
    ...h, stage: stageOf(h), candidateLabel: h.candidate ? CANDIDATE_LABEL : null, directionsUrl: directionsUrl(h),
    contractsSummary: { total: contracts.length, active: contracts.filter((c) => c.status === 'active').length, latest: contracts.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.reference || null },
    networkRecords: db.find('hospitalNetworks', (r) => r.hospitalId === h.id).map(networkView),
    gaps: Object.fromEntries((NEXT[stageOf(h)] || []).filter((x) => !['Terminated', 'Prospect', 'Suspended'].includes(x)).map((x) => [x, stageGaps(h, x)])),
    nextStages: NEXT[stageOf(h)] || [],
  };
}

export const registryRow = (h) => ({
  id: h.id, name: h.name, providerType: h.providerType || 'hospital', city: h.city, state: h.state, stage: stageOf(h), active: !!h.active,
  candidate: !!h.candidate, candidateLabel: h.candidate ? CANDIDATE_LABEL : null, network: !!h.network,
  verificationStatus: h.verificationStatus || 'unverified', pendingVerification: h.pendingVerification || [],
  nabh: (() => { const a = (h.accreditations || []).find((x) => x.body === 'NABH'); return a ? (a.verified ? 'verified' : 'claimed') : 'none'; })(),
  integration: h.integration?.status || 'Not started', updatedAt: h.updatedAt,
});

// ---------- directory search ----------
export function searchDirectory(q = {}) {
  const date = isDate(q.date) ? q.date : today();
  let insurerId = s(q.insurerId) || null;
  const planId = s(q.planId) || null;
  if (planId) {
    const plan = db.get('plans', planId);
    if (!plan || !isPublicInsurer(plan.insurerId)) throw notFound('Plan not found');
    if (insurerId && plan.insurerId !== insurerId) throw bad('The selected plan does not belong to the selected insurer');
    insurerId = plan.insurerId;
  }
  if (insurerId && !isPublicInsurer(insurerId)) throw notFound('Insurer not found');
  const yes = (v) => v === true || v === 'true' || v === '1';
  const service = s(q.service);
  const rows = [];
  for (const h of db.all('hospitals')) {
    if (!isPublicProvider(h)) continue;
    if (q.q && !lc(h.name).includes(lc(q.q))) continue;
    if (q.city && !lc(h.city).includes(lc(q.city))) continue;
    if (q.state && lc(h.state) !== lc(q.state)) continue;
    if ((q.pin || q.postalCode) && !String(h.postalCode || '').startsWith(s(q.pin || q.postalCode))) continue;
    if (q.providerType && (h.providerType || 'hospital') !== q.providerType) continue;
    if (q.specialty && !(h.specialties || []).some((x) => lc(x).includes(lc(q.specialty)))) continue;
    if (service && !(h.supportedServices || []).some((x) => lc(x).includes(lc(service)))
      && !db.findOne('providerServices', (x) => x.hospitalId === h.id && x.active !== false && x.category === service)) continue;
    if (yes(q.emergency) && !h.emergency?.available) continue;
    if (yes(q.accredited) && !verifiedAccreditations(h, date).length) continue;
    const view = publicProvider(h, { date });
    if (insurerId) view.cashless = cashlessStatus({ hospitalId: h.id, insurerId, planId, service: NETWORK_SERVICES.includes(q.networkService) ? q.networkService : undefined, date });
    if (yes(q.cashless)) {
      if (!insurerId) throw bad('Choose an insurer (and optionally a plan) to filter by cashless eligibility');
      if (!view.cashless.eligible) continue;
    }
    rows.push(view);
  }
  rows.sort((a, b) => (Number(!!b.cashless?.eligible) - Number(!!a.cashless?.eligible)) || a.name.localeCompare(b.name));
  return { disclaimer: DIRECTORY_DISCLAIMER, date, insurerId, planId, providers: rows };
}

export function directoryMeta() {
  const insurers = publicInsurers().map((i) => ({
    id: i.id, name: i.name, sandbox: !!i.sandbox,
    plans: db.find('plans', (p) => p.insurerId === i.id && p.product === 'health' && p.active !== false).map((p) => ({ id: p.id, name: p.name })),
  }));
  const pub = db.all('hospitals').filter(isPublicProvider);
  const uniq = (f) => [...new Set(pub.flatMap(f).filter(Boolean))].sort();
  return {
    insurers, providerTypes: PROVIDER_TYPES, cities: uniq((h) => [h.city]), states: uniq((h) => [h.state]),
    specialties: uniq((h) => h.specialties || []), services: uniq((h) => h.supportedServices || []), networkServices: NETWORK_SERVICES,
    disclaimer: DIRECTORY_DISCLAIMER,
  };
}

/** Expiring network records (for operations follow-up). */
export const expiringNetworks = (days = 60) => {
  const t = today(), until = addDays(t, days);
  return db.find('hospitalNetworks', (r) => r.effectiveTo && r.effectiveTo >= t && r.effectiveTo <= until).map(networkView);
};
