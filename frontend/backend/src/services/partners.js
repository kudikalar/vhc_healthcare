// Partners module — insurer registry and onboarding (spec §11, §2.11–2.12).
//
// Onboarding is a gated state machine:
//   Prospect → Due Diligence → Legal Review → Agreement Signed → API Integration → Sandbox Testing → Certified → Active
//   Active ⇄ Suspended, Active/Suspended → Expired → (Legal Review | Agreement Signed)
// Each forward move requires the current stage's checklist plus stage-specific gates. Going Active needs a
// signed, valid agreement, at least one authorised product, a certified integration on a deployed adapter
// and — for any non-sandbox insurer — explicit regulatory approval for live sales. Without that approval
// the insurer stays "BLOCKED BY REGULATORY APPROVAL". Real-company *candidates* can never be published.
//
// Integration credentials are never stored: only a reference to the secrets vault (integration.credentialsRef).
import { db, newId } from '../db.js';
import { now, today } from '../clock.js';
import { bad, conflict, notFound, unprocessable } from '../utils/errors.js';
import { isValidDate } from '../utils/dates.js';
import { audit, notify } from './audit.js';
import { publish } from './events.js';
import { registerJob } from './jobs.js';
import { adapterKeys, distributionStatus, getAdapter, SANDBOX_INSURER_ID } from './insurerHub.js';
import { currentVersion } from './pricing.js';

export const STAGES = ['Prospect', 'Due Diligence', 'Legal Review', 'Agreement Signed', 'API Integration', 'Sandbox Testing', 'Certified', 'Active'];
export const STATUSES = [...STAGES, 'Suspended', 'Expired'];
export const TRANSITIONS = {
  Prospect: ['Due Diligence'],
  'Due Diligence': ['Legal Review', 'Prospect'],
  'Legal Review': ['Agreement Signed', 'Due Diligence'],
  'Agreement Signed': ['API Integration'],
  'API Integration': ['Sandbox Testing'],
  'Sandbox Testing': ['Certified', 'API Integration'],
  Certified: ['Active'],
  Active: ['Suspended', 'Expired'],
  Suspended: ['Active', 'Expired'],
  Expired: ['Legal Review', 'Agreement Signed'],
};
export const CANDIDATE_LABEL = 'Candidate — no agreement';
export const REG_BLOCK_LABEL = 'BLOCKED BY REGULATORY APPROVAL';

/** Checklist per stage. Completing a stage's required tasks is a gate for leaving it (forwards). */
export const STAGE_TASKS = {
  Prospect: ['Record insurer profile and contacts', 'Initial partnership discussion held'],
  'Due Diligence': ['Verify IRDAI registration on the official registry', 'Collect compliance documents', 'Financial and reputational due diligence'],
  'Legal Review': ['Draft distribution / technology agreement', 'Legal and compliance sign-off', 'Data-processing agreement agreed'],
  'Agreement Signed': ['Countersigned agreement filed', 'Commission / remuneration schedule recorded', 'Authorised products and UINs recorded'],
  'API Integration': ['Adapter configured for the insurer API', 'Credentials stored in the secrets vault (reference recorded)'],
  'Sandbox Testing': ['End-to-end test: quote → proposal → issuance', 'Decline and refund path tested', 'Premium reconciliation tested'],
  Certified: ['Integration certification sign-off', 'Go-live checklist approved'],
  Active: ['Escalation matrix confirmed', 'Monitoring and alerting enabled'],
};
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
export function buildTasks(doneThrough = null) {
  const doneIdx = doneThrough ? STAGES.indexOf(doneThrough) : -1;
  return STAGES.flatMap((stage, si) => STAGE_TASKS[stage].map((title) => ({
    id: `${slug(stage)}__${slug(title)}`.slice(0, 80), stage, title, required: true,
    done: si <= doneIdx, doneAt: si <= doneIdx ? now().toISOString() : null, doneBy: si <= doneIdx ? 'System (seed)' : null, note: null,
  })));
}

// ---------- validation ----------
const SECRET_KEY = /(password|passwd|secret|api[-_]?key|access[-_]?token|private[-_]?key|client[-_]?secret|bearer)/i;
function assertNoSecrets(obj, path = '') {
  if (!obj || typeof obj !== 'object') return;
  for (const [k, v] of Object.entries(obj)) {
    if (k !== 'credentialsRef' && SECRET_KEY.test(k)) {
      throw bad(`"${path}${k}" looks like a credential. Secrets are never stored here — record a vault reference in integration.credentialsRef.`);
    }
    if (v && typeof v === 'object') assertNoSecrets(v, `${path}${k}.`);
  }
}
const str = (v, max = 200) => (v == null ? '' : String(v).trim().slice(0, max));
const strList = (v, max = 50) => (Array.isArray(v) ? v.map((x) => str(x)).filter(Boolean).slice(0, max) : []);
const emailOk = (e) => !e || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const dateOrNull = (v, field) => {
  if (v == null || v === '') return null;
  if (!isValidDate(v)) throw bad(`${field} must be a date (YYYY-MM-DD)`);
  return v;
};
function contactList(v, field) {
  if (!Array.isArray(v)) return [];
  return v.slice(0, 20).map((c, i) => {
    const out = { name: str(c.name, 100), role: str(c.role, 100), email: str(c.email, 120), phone: str(c.phone, 30) };
    if (!out.name && !out.email) throw bad(`${field}[${i}]: a name or email is required`);
    if (!emailOk(out.email)) throw bad(`${field}[${i}]: invalid email`);
    if (c.level != null) out.level = Number(c.level) || 1;
    return out;
  });
}
const DOC_STATUSES = ['Pending', 'Received', 'Verified', 'Expired'];
const INTEGRATION_TYPES = ['in-process', 'rest-api', 'soap-api', 'sftp-batch', 'insurer-portal', 'manual'];

/** Applies an admin update (partial) to an insurer record after validation. */
export function applyInsurerUpdate(ins, body, { creating = false } = {}) {
  const b = body || {};
  assertNoSecrets(b);
  if (b.name !== undefined) { ins.name = str(b.name, 120); if (!ins.name) throw bad('Name is required'); }
  if (b.legalName !== undefined) ins.legalName = str(b.legalName, 200);
  if (b.type !== undefined) ins.type = str(b.type, 80);
  if (creating) ins.sandbox = b.sandbox === true;
  if (b.irdai !== undefined) {
    const prev = ins.irdai || {};
    const verified = b.irdai.verified === true;
    ins.irdai = {
      registrationNo: str(b.irdai.registrationNo ?? prev.registrationNo, 60), verified,
      verifiedAt: verified ? prev.verifiedAt || now().toISOString() : null, verifiedBy: verified ? str(b.irdai.verifiedBy, 100) || prev.verifiedBy || null : null,
      note: str(b.irdai.note ?? prev.note, 300),
    };
    if (verified && !ins.irdai.registrationNo) throw bad('An IRDAI registration number is required before marking it verified');
  }
  if (b.contacts !== undefined) ins.contacts = contactList(b.contacts, 'contacts');
  if (b.escalation !== undefined) ins.escalation = contactList(b.escalation, 'escalation');
  if (b.claimsContact !== undefined) ins.claimsContact = { phone: str(b.claimsContact?.phone, 30), email: str(b.claimsContact?.email, 120), hours: str(b.claimsContact?.hours, 80) };
  if (b.agreement !== undefined) {
    if (b.agreement === null) ins.agreement = null;
    else {
      const a = b.agreement;
      const commissionBp = a.commissionBp == null || a.commissionBp === '' ? null : Number(a.commissionBp);
      if (commissionBp != null && (!Number.isInteger(commissionBp) || commissionBp < 0 || commissionBp > 10000)) throw bad('agreement.commissionBp must be whole basis points between 0 and 10000');
      ins.agreement = {
        reference: str(a.reference, 80), signedAt: dateOrNull(a.signedAt, 'agreement.signedAt'),
        validFrom: dateOrNull(a.validFrom, 'agreement.validFrom'), validTo: dateOrNull(a.validTo, 'agreement.validTo'),
        commissionBp, premiumCollection: str(a.premiumCollection ?? a.premiumArrangement, 300), remuneration: str(a.remuneration, 300),
      };
      if (ins.agreement.validFrom && ins.agreement.validTo && ins.agreement.validTo < ins.agreement.validFrom) throw bad('agreement.validTo must be after validFrom');
    }
  }
  if (b.geographies !== undefined) ins.geographies = strList(b.geographies);
  if (b.integration !== undefined) {
    const it = b.integration || {};
    const type = str(it.type ?? ins.integration?.type, 40) || null;
    if (type && !INTEGRATION_TYPES.includes(type)) throw bad(`integration.type must be one of ${INTEGRATION_TYPES.join(', ')}`);
    const adapter = str(it.adapter ?? ins.integration?.adapter, 60) || null;
    if (adapter && getAdapter(adapter)?.sandboxOnly && !ins.sandbox) throw bad('The sandbox simulator adapter can only be used by synthetic sandbox insurers');
    const changed = adapter !== (ins.integration?.adapter || null);
    ins.integration = {
      ...(ins.integration || {}), type, adapter, protocol: str(it.protocol ?? ins.integration?.protocol, 60) || null,
      credentialsRef: str(it.credentialsRef ?? ins.integration?.credentialsRef, 200) || null,
      endpointRef: str(it.endpointRef ?? ins.integration?.endpointRef, 200) || null,
      status: changed ? 'Not certified' : ins.integration?.status || 'Not started',
      ...(changed ? { lastTest: null } : {}),
    };
  }
  if (b.complianceDocuments !== undefined) {
    ins.complianceDocuments = (Array.isArray(b.complianceDocuments) ? b.complianceDocuments : []).slice(0, 40).map((d, i) => {
      const status = d.status || 'Pending';
      if (!DOC_STATUSES.includes(status)) throw bad(`complianceDocuments[${i}].status must be one of ${DOC_STATUSES.join(', ')}`);
      if (!str(d.name)) throw bad(`complianceDocuments[${i}].name is required`);
      return { name: str(d.name, 120), reference: str(d.reference, 120), status, validTo: dateOrNull(d.validTo, `complianceDocuments[${i}].validTo`) };
    });
  }
  if (b.regulatoryApproval !== undefined) {
    const r = b.regulatoryApproval || {};
    const approved = r.liveSalesApproved === true;
    if (approved && ins.sandbox) throw bad('Synthetic sandbox insurers can never be approved for live sales');
    if (approved && !str(r.reference)) throw bad('Record the regulatory approval reference before enabling live sales');
    ins.regulatoryApproval = { liveSalesApproved: approved, reference: str(r.reference, 120) || null, note: str(r.note, 300) || null, recordedAt: now().toISOString() };
  }
  if (b.publishable !== undefined) {
    if (b.publishable === true) {
      if (ins.candidate) throw conflict(`${ins.name} is a candidate (no agreement) and can never be published`);
      if (ins.status !== 'Active') throw conflict('Only Active insurers can be published');
    }
    ins.publishable = b.publishable === true;
  }
  return ins;
}

// ---------- gates ----------
export function agreementValid(ins, at = today()) {
  const a = ins.agreement;
  return !!(a && a.reference && a.signedAt && a.validFrom && a.validTo && a.validFrom <= at && a.validTo >= at && Number.isInteger(a.commissionBp));
}
const tasksDone = (ins, stage) => (ins.onboardingTasks || []).filter((t) => t.stage === stage && t.required).every((t) => t.done);
const check = (key, label, ok, detail = null, extra = {}) => ({ key, label, ok: !!ok, detail: ok ? null : detail, ...extra });

/** Gate checks for moving `ins` to `to`. */
export function gateChecks(ins, to) {
  const from = ins.status;
  const forward = STAGES.indexOf(to) > STAGES.indexOf(from) && STAGES.includes(from);
  const out = [];
  if (forward) out.push(check('tasks', `"${from}" checklist complete`, tasksDone(ins, from), `Complete every required "${from}" task first`));
  const products = (ins.authorizedPlanIds || []).filter((id) => db.get('plans', id));
  if (to === 'Due Diligence') out.push(check('profile', 'Legal name and at least one contact recorded', ins.legalName && ins.contacts?.length, 'Add the legal name and a contact'));
  if (to === 'Legal Review') {
    out.push(check('irdai', 'IRDAI registration verified', ins.sandbox || (ins.irdai?.registrationNo && ins.irdai?.verified), 'Verify the IRDAI registration number against the official registry'));
  }
  if (to === 'Agreement Signed') out.push(check('agreement', 'Signed agreement with valid dates and commission', agreementValid(ins), 'Record agreement reference, signed date, validity window covering today and commission (bp)'));
  if (to === 'API Integration') out.push(check('products', 'At least one authorised product (with UIN)', products.length > 0, 'Authorise at least one product under the agreement'));
  if (to === 'Sandbox Testing') {
    out.push(check('adapter', 'Integration adapter configured', ins.integration?.adapter, 'Choose the integration adapter'));
    out.push(check('credentials', 'Credentials vault reference recorded', ins.integration?.credentialsRef, 'Record where the credentials are held (vault reference, never the secret)'));
  }
  if (to === 'Certified') out.push(check('integration_test', 'Integration certification test passed', ins.integration?.lastTest?.ok, 'Run the certification test (or record manual certification evidence)'));
  if (to === 'Active') {
    out.push(check('agreement', 'Signed agreement valid today', agreementValid(ins), 'The agreement is missing or outside its validity window'));
    out.push(check('products', 'At least one authorised product', products.length > 0, 'Authorise at least one product'));
    out.push(check('certified', 'Integration certified', ins.integration?.status === 'Certified', 'Integration must be certified'));
    out.push(check('adapter_deployed', 'Adapter deployed on the Integration Hub', adapterKeys().includes(ins.integration?.adapter), `Adapter "${ins.integration?.adapter || '-'}" is not deployed; real adapters are built per signed agreement`));
    if (!ins.sandbox) out.push(check('regulatory', 'Regulatory approval for live sales', ins.regulatoryApproval?.liveSalesApproved, REG_BLOCK_LABEL, { regulatory: true }));
  }
  return out;
}

/** What still stops this insurer from selling live (shown on detail pages). */
export function liveSalesStatus(ins) {
  if (ins.candidate) return { label: CANDIDATE_LABEL, blocked: true };
  if (ins.sandbox) return { label: 'Sandbox only — test payments, never live sales', blocked: true };
  if (!ins.regulatoryApproval?.liveSalesApproved) return { label: REG_BLOCK_LABEL, blocked: true, regulatory: true };
  if (ins.status !== 'Active') return { label: `Not active (${ins.status})`, blocked: true };
  return { label: 'Live sales permitted', blocked: false };
}

// ---------- views ----------
export function insurerSummary(ins) {
  return {
    id: ins.id, name: ins.name, legalName: ins.legalName, type: ins.type, status: ins.status, sandbox: !!ins.sandbox, candidate: !!ins.candidate,
    label: ins.candidate ? CANDIDATE_LABEL : ins.sandbox ? 'Synthetic sandbox insurer' : null, publishable: !!ins.publishable,
    irdaiVerified: !!ins.irdai?.verified, agreementValid: agreementValid(ins), agreementValidTo: ins.agreement?.validTo || null,
    products: (ins.authorizedPlanIds || []).length, integrationStatus: ins.integration?.status || 'Not started', adapter: ins.integration?.adapter || null,
    liveSales: liveSalesStatus(ins),
    tasksDone: (ins.onboardingTasks || []).filter((t) => t.done).length, tasksTotal: (ins.onboardingTasks || []).length,
    updatedAt: ins.updatedAt,
  };
}

export function insurerDetail(ins) {
  const v = structuredClone(ins);
  delete v.secrets; // defensive: never echo anything secret-like
  v.label = ins.candidate ? CANDIDATE_LABEL : ins.sandbox ? 'Synthetic sandbox insurer' : null;
  v.agreementValid = agreementValid(ins);
  v.liveSales = liveSalesStatus(ins);
  v.products = (ins.authorizedPlanIds || []).map((id) => db.get('plans', id)).filter(Boolean).map((p) => ({
    id: p.id, name: p.name, product: p.product, type: p.type, uin: ins.uins?.[p.id] || p.uin || null, version: currentVersion(p).version,
    linked: p.insurerId === ins.id, distribution: p.insurerId === ins.id ? distributionStatus(p) : { allowed: false, reason: `Product is linked to another insurer (${p.insurerName || p.insurerId})` },
  }));
  v.nextStatuses = (TRANSITIONS[ins.status] || []).map((to) => ({ status: to, gates: gateChecks(ins, to) }));
  v.activationGates = gateChecks({ ...ins, status: 'Certified' }, 'Active').filter((g) => g.key !== 'tasks');
  v.stages = STAGES;
  v.partnerUsers = db.find('users', (u) => u.orgId === ins.id && ['insurer_admin', 'insurer_user'].includes(u.role)).map((u) => ({ id: u.id, name: u.name, role: u.role, status: u.status }));
  return v;
}

export const loadInsurer = (id) => {
  const ins = db.get('insurers', id);
  if (!ins) throw notFound('Insurer not found');
  return ins;
};

// ---------- mutations ----------
export function createInsurer(body, actor) {
  if (!str(body?.name)) throw bad('Name is required');
  if (db.findOne('insurers', (i) => i.name.toLowerCase() === str(body.name).toLowerCase())) throw conflict('An insurer with this name already exists');
  const ins = {
    id: newId('ins'), status: 'Prospect', publishable: false, candidate: false, sandbox: false, authorizedPlanIds: [], uins: {}, geographies: [],
    contacts: [], escalation: [], complianceDocuments: [], agreement: null,
    irdai: { registrationNo: '', verified: false, note: '' }, integration: { type: null, adapter: null, protocol: null, credentialsRef: null, status: 'Not started' },
    regulatoryApproval: { liveSalesApproved: false }, onboardingTasks: buildTasks(), onboardingHistory: [],
  };
  applyInsurerUpdate(ins, { ...body, publishable: undefined, regulatoryApproval: undefined }, { creating: true });
  if (ins.sandbox && !/synthetic|sandbox/i.test(ins.name)) ins.name = `${ins.name} (Synthetic)`;
  ins.onboardingHistory.push({ at: now().toISOString(), from: null, status: 'Prospect', by: actor.name, note: 'Insurer created' });
  const rec = db.insert('insurers', ins);
  audit(actor, 'INSURER_CREATED', 'insurer', rec.id, { name: rec.name, sandbox: rec.sandbox });
  return rec;
}

export function transitionInsurer(ins, to, actor, note) {
  if (!STATUSES.includes(to)) throw bad(`status must be one of ${STATUSES.join(', ')}`);
  const from = ins.status;
  if (!(TRANSITIONS[from] || []).includes(to)) throw conflict(`An insurer cannot move from ${from} to ${to}. Allowed: ${(TRANSITIONS[from] || []).join(', ') || 'none'}`);
  if (to === 'Suspended' && !str(note)) throw bad('A reason is required to suspend an insurer');
  const gates = gateChecks(ins, to);
  const failing = gates.filter((g) => !g.ok);
  if (failing.length) {
    const regulatory = failing.some((g) => g.regulatory);
    const msg = regulatory
      ? `${REG_BLOCK_LABEL}: live sales have not been approved${failing.length > 1 ? `; also ${failing.filter((g) => !g.regulatory).map((g) => g.label).join('; ')}` : ''}`
      : `Cannot move to ${to}: ${failing.map((g) => g.detail || g.label).join('; ')}`;
    throw unprocessable(msg, { gates, blockedBy: failing.map((g) => g.key), code: regulatory ? 'BLOCKED_BY_REGULATORY_APPROVAL' : 'ONBOARDING_GATE_FAILED', errors: failing.map((g) => g.detail || g.label) });
  }
  ins.status = to;
  if (to !== 'Active') ins.publishable = false;
  if (to === 'Certified') ins.integration = { ...ins.integration, status: 'Certified', certifiedAt: now().toISOString() };
  if (to === 'Active') ins.activatedAt = now().toISOString();
  ins.onboardingHistory = ins.onboardingHistory || [];
  ins.onboardingHistory.push({ at: now().toISOString(), from, status: to, by: actor.name, role: actor.role, note: str(note, 500) || null });
  db.touch(ins);
  audit(actor, 'INSURER_STATUS_CHANGED', 'insurer', ins.id, { from, to, note: str(note, 500) || null });
  publish('INSURER_STATUS_CHANGED', { insurerId: ins.id, from, to }, { actor, subject: { type: 'insurer', id: ins.id } });
  for (const u of db.find('users', (x) => x.orgId === ins.id && ['insurer_admin', 'insurer_user'].includes(x.role))) {
    notify(u.id, 'Partnership status updated', `${ins.name} is now ${to} on VHC.`, { link: '/insurer' });
  }
  return ins;
}

export function setTask(ins, taskId, { done, note }, actor) {
  const t = (ins.onboardingTasks || []).find((x) => x.id === taskId);
  if (!t) throw notFound('Task not found');
  t.done = done === true;
  t.doneAt = t.done ? now().toISOString() : null;
  t.doneBy = t.done ? actor.name : null;
  if (note !== undefined) t.note = str(note, 300) || null;
  db.touch(ins);
  audit(actor, t.done ? 'INSURER_TASK_DONE' : 'INSURER_TASK_REOPENED', 'insurer', ins.id, { task: t.id, stage: t.stage });
  return t;
}

export function runIntegrationTest(ins, actor, { evidenceRef } = {}) {
  const key = ins.integration?.adapter;
  if (!key) throw conflict('Configure an integration adapter first');
  let result;
  if (evidenceRef !== undefined) {
    if (!str(evidenceRef)) throw bad('An evidence reference (e.g. the UAT test report id) is required for manual certification');
    if (getAdapter(key)?.sandboxOnly) throw bad('Sandbox simulator integrations are certified by the automated test');
    result = { ok: true, method: 'manual-evidence', evidenceRef: str(evidenceRef, 200), note: 'Certification evidence recorded by an administrator' };
  } else {
    const adapter = getAdapter(key);
    if (!adapter) result = { ok: false, method: 'automated', note: `Adapter "${key}" is not deployed on the Integration Hub` };
    else if (typeof adapter.certify !== 'function') result = { ok: false, method: 'automated', note: 'This adapter has no automated certification; record manual evidence' };
    else result = { method: 'automated', ...adapter.certify(ins) };
  }
  ins.integration = { ...ins.integration, lastTest: { ...result, at: now().toISOString(), by: actor.name }, status: ins.integration.status === 'Certified' ? 'Certified' : result.ok ? 'Test passed' : 'Test failed' };
  db.touch(ins);
  audit(actor, 'INSURER_INTEGRATION_TEST', 'insurer', ins.id, { ok: result.ok, method: result.method });
  return ins.integration.lastTest;
}

/** Authorises a product (plan) under an insurer's agreement and links the plan to that insurer. */
export function authoriseProduct(ins, { planId, uin, categories }, actor) {
  const plan = db.get('plans', planId);
  if (!plan) throw notFound('Plan not found');
  if (ins.candidate) throw conflict(`${ins.name} is a candidate with no agreement; products cannot be authorised`);
  const cleanUin = str(uin, 60);
  if (!cleanUin) throw bad('The product UIN is required');
  if (plan.insurerId && plan.insurerId !== ins.id) {
    const other = db.get('insurers', plan.insurerId);
    const sold = db.findOne('policies', (p) => p.planId === plan.id);
    if (sold || (other && other.status === 'Active')) throw conflict(`This product belongs to ${other?.name || plan.insurerId}; create a separate product for ${ins.name}`);
  }
  ins.authorizedPlanIds = [...new Set([...(ins.authorizedPlanIds || []), plan.id])];
  ins.uins = { ...(ins.uins || {}), [plan.id]: cleanUin };
  Object.assign(plan, { insurerId: ins.id, insurerName: ins.name, uin: cleanUin, sandbox: !!ins.sandbox });
  if (Array.isArray(categories)) plan.categories = categories.map((c) => str(c, 40)).filter(Boolean);
  db.touch(plan);
  db.touch(ins);
  audit(actor, 'INSURER_PRODUCT_AUTHORISED', 'insurer', ins.id, { planId: plan.id, uin: cleanUin });
  return plan;
}

export function revokeProduct(ins, planId, actor) {
  if (!(ins.authorizedPlanIds || []).includes(planId)) throw notFound('Product is not authorised for this insurer');
  ins.authorizedPlanIds = ins.authorizedPlanIds.filter((x) => x !== planId);
  db.touch(ins);
  audit(actor, 'INSURER_PRODUCT_REVOKED', 'insurer', ins.id, { planId });
  return ins;
}

// Agreements that lapse move Active/Suspended non-sandbox insurers to Expired (the synthetic sandbox insurer is exempt).
registerJob(() => {
  let expired = 0;
  const t = today();
  for (const ins of db.all('insurers')) {
    if (ins.sandbox || ins.id === SANDBOX_INSURER_ID || !['Active', 'Suspended'].includes(ins.status)) continue;
    if (ins.agreement?.validTo && ins.agreement.validTo < t) {
      transitionInsurer(ins, 'Expired', { name: 'Agreement expiry job', role: 'system' }, `Agreement ${ins.agreement.reference} expired on ${ins.agreement.validTo}`);
      expired++;
    }
  }
  return expired ? { insurersExpired: expired } : {};
});
