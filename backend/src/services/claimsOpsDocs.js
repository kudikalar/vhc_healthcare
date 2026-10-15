// Claims document intelligence (rule-based assistance only).
//
// Builds the insurer-specific document checklist for a claim, detects missing and duplicate documents,
// runs simple file-quality checks and writes a plain-language timeline summary from recorded events.
// It never reads or interprets clinical content, never invents medical facts and never makes or
// recommends a claim decision — everything here is labelled as assistance for humans.
import { db } from '../db.js';
import { claimTimestamps } from './claimsOpsSla.js';

export const ASSIST_DISCLAIMER = 'Automated document assistance based on checklist rules. It does not read medical content and is not a claim decision — the insurer decides the claim.';

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 });
export const rupees = (paise) => (paise == null ? '—' : inr.format(paise / 100));
const stamp = (iso) => (iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : '—');

// Checklist building blocks. `stage`: when the document becomes necessary for a cashless claim
// ('preauth' at the pre-authorisation request, 'discharge' once the patient is being discharged).
const ITEMS = {
  photo_id: { label: 'Photo ID of the patient and policy e-card', categories: ['identity'], stage: 'preauth', hint: 'A copy of Aadhaar, PAN, passport or voter ID. The policy e-card is available under My policies.' },
  admission_advice: { label: "Doctor's admission advice with supporting reports", categories: ['medical_report', 'exam_report', 'prescription'], stage: 'preauth', hint: 'The treating doctor’s note advising admission, with the reports it refers to. The hospital insurance desk usually sends this.' },
  final_bill: { label: 'Itemised final hospital bill with payment receipts', categories: ['bill'], stage: 'discharge', hint: 'Ask the hospital billing desk for the itemised (not summary) bill and the receipts for what you paid.' },
  discharge_summary: { label: 'Discharge summary', categories: ['discharge_summary'], stage: 'discharge', hint: 'Issued by the hospital at discharge and signed by the treating doctor.' },
  investigation_reports: { label: 'Investigation / diagnostic reports', categories: ['medical_report', 'exam_report'], stage: 'discharge', hint: 'Lab, imaging and other test reports for the tests listed in the bill.' },
  prescriptions: { label: 'Prescriptions with pharmacy bills', categories: ['prescription'], stage: 'discharge', hint: 'Prescriptions for medicines bought outside the hospital, with the pharmacy bills.' },
  bank_proof: { label: 'Cancelled cheque or bank statement for the payout account', categories: ['bank_proof'], stage: 'discharge', hint: 'Must show the account holder name, account number and IFSC used in the claim.' },
  accident_proof: { label: 'FIR or medico-legal certificate (accident claims)', categories: ['other'], stage: 'discharge', hint: 'Needed only for accident-related treatment; available from the police station or the hospital.', when: (c) => c.isAccident },
};

// Insurer-specific checklists (keyed by insurer id; `default` applies to any other insurer). An admin
// or partner module can override one by adding an `insurerClaimChecklists` record with the insurer id.
const CHECKLISTS = {
  default: {
    cashless: [['photo_id', true], ['admission_advice', true], ['final_bill', true], ['discharge_summary', true], ['investigation_reports', false], ['accident_proof', true]],
    reimbursement: [['photo_id', true], ['final_bill', true], ['discharge_summary', true], ['investigation_reports', true], ['prescriptions', false], ['bank_proof', true], ['accident_proof', true]],
  },
  ins_sandbox: {
    cashless: [['photo_id', true], ['admission_advice', true], ['final_bill', true], ['discharge_summary', true], ['investigation_reports', true], ['accident_proof', true]],
    reimbursement: [['photo_id', true], ['final_bill', true], ['discharge_summary', true], ['investigation_reports', true], ['prescriptions', true], ['bank_proof', true], ['accident_proof', true]],
  },
};

export function checklistDefinition(insurerId, type) {
  const override = insurerId && db.get('insurerClaimChecklists', insurerId);
  const def = override?.[type] || CHECKLISTS[insurerId]?.[type] || CHECKLISTS.default[type] || [];
  return { source: override ? 'insurer' : CHECKLISTS[insurerId] ? `${insurerId} checklist` : 'VHC default checklist', items: def };
}

/** Which checklist stages are currently due for a claim. */
function dueStages(c) {
  if (c.type !== 'cashless') return ['preauth', 'discharge'];
  const pre = ['Preauth Requested'].includes(c.status) || (c.status === 'Documents Requested' && c.resumeStatus === 'Preauth Requested');
  return pre || c.status === 'Preauth Rejected' ? ['preauth'] : ['preauth', 'discharge'];
}

/** Quality checks on one stored document (metadata only — content is never interpreted). */
export function documentQuality(d) {
  const issues = [];
  if (d.size < 15 * 1024) issues.push('Very small file — it may be blank, cropped or unreadable. Check that every page is included.');
  if (d.size > 4.5 * 1024 * 1024) issues.push('Close to the 5 MB limit — if pages are missing, split the document into parts.');
  if (d.mime !== 'application/pdf' && ['bill', 'discharge_summary'].includes(d.category)) issues.push('Photo of a multi-page document — a single PDF scan of all pages is easier for the insurer to process.');
  return issues;
}

/**
 * Document intelligence for a claim. `audience` 'customer' omits cross-claim matching (which belongs in
 * the fraud review queue) and staff-only detail.
 */
export function claimDocumentIntel(c, { audience = 'staff' } = {}) {
  const docs = db.find('documents', (d) => d.entityType === 'healthClaim' && d.entityId === c.id);
  const { source, items } = checklistDefinition(c.insurerId, c.type);
  const stages = dueStages(c);
  const checklist = items.map(([key, required]) => {
    const def = ITEMS[key];
    if (!def || (def.when && !def.when(c))) return null;
    const matches = docs.filter((d) => def.categories.includes(d.category));
    const needed = stages.includes(def.stage);
    const status = matches.length ? 'received' : !needed ? 'not_yet_needed' : required ? 'missing' : 'optional';
    return { key, label: def.label, required, categories: def.categories, stage: def.stage, status, documentIds: matches.map((d) => d.id), hint: def.hint };
  }).filter(Boolean);

  const requests = (c.documentRequests || []).filter((r) => !r.resolved).map((r) => ({ key: `request:${r.at}`, label: r.note, requestedAt: r.at, requestedBy: r.by, status: 'requested' }));
  const missing = checklist.filter((i) => i.status === 'missing');

  const bySha = new Map();
  for (const d of docs) if (d.sha256) bySha.set(d.sha256, [...(bySha.get(d.sha256) || []), d]);
  const duplicates = [...bySha.values()].filter((g) => g.length > 1).map((g) => ({ filename: g[0].filename, documentIds: g.map((d) => d.id), count: g.length, note: 'The same file was uploaded more than once to this claim. Nothing to do unless a different document was intended.' }));

  const quality = docs.map((d) => ({ documentId: d.id, filename: d.filename, category: d.category, issues: documentQuality(d) })).filter((q) => q.issues.length);

  const suggestions = [
    ...requests.map((r) => `Requested by the claims team: ${r.label}`),
    ...missing.map((i) => `${i.label} — ${i.hint}`),
    ...quality.map((q) => `${q.filename}: ${q.issues[0]}`),
  ];
  const out = {
    disclaimer: ASSIST_DISCLAIMER, checklistSource: source, checklist, outstandingRequests: requests, missing: missing.map((i) => i.key),
    pendingDocuments: [...requests.map((r) => ({ key: r.key, label: r.label, kind: 'request', categories: null })), ...missing.map((i) => ({ key: i.key, label: i.label, kind: 'checklist', categories: i.categories, hint: i.hint }))],
    duplicates, quality, suggestions, documentCount: docs.length,
    complete: missing.length === 0 && requests.length === 0,
  };
  if (audience === 'staff') {
    out.crossClaimMatches = docs.filter((d) => d.sha256).flatMap((d) => db.find('documents', (o) => o.sha256 === d.sha256 && o.entityType === 'healthClaim' && o.entityId !== c.id)
      .map((o) => ({ documentId: d.id, filename: d.filename, otherClaimId: o.entityId, otherClaimNumber: db.get('healthClaims', o.entityId)?.claimNumber || o.entityId })));
  }
  return out;
}

/** Plain-language timeline summary built from recorded timestamps and events (no clinical facts). */
export function claimTimelineSummary(c) {
  const ts = claimTimestamps(c);
  const parts = [];
  parts.push(`${c.claimNumber} is a ${c.type} claim at ${c.hospitalName}${c.networkHospital ? ' (network hospital)' : ''}, registered on ${stamp(ts.submittedAt)}${c.insurerClaimRef ? ` with insurer reference ${c.insurerClaimRef}` : ''}.`);
  if (ts.intimatedAt) parts.push(`The claim was first intimated on ${stamp(ts.intimatedAt)}.`);
  if (c.type === 'cashless') {
    parts.push(`Pre-authorisation was requested on ${stamp(ts.preauthRequestedAt)}${ts.preauthDecidedAt ? ` and decided on ${stamp(ts.preauthDecidedAt)}` : ' and is awaiting a decision'}.`);
    if (c.preauth?.status === 'approved') parts.push(`The pre-authorisation was approved provisionally for ${rupees(c.preauth.amount)}.`);
    if (c.preauth?.status === 'rejected') parts.push('The pre-authorisation was refused; a reimbursement claim remains possible.');
    if (ts.finalBillRequestedAt) parts.push(`A final bill of ${rupees(c.finalBill?.amount)} was submitted on ${stamp(ts.finalBillRequestedAt)}${ts.finalBillDecidedAt ? ` and finally authorised/decided on ${stamp(ts.finalBillDecidedAt)}` : ''}.`);
  }
  const requests = c.documentRequests || [];
  if (requests.length) parts.push(`${requests.length} document request(s) were raised; ${requests.filter((r) => !r.resolved).length} remain open.`);
  if (ts.approvedAt) parts.push(`The claim was approved for ${rupees(c.assessment?.approvedAmount)} on ${stamp(ts.approvedAt)}.`);
  if (ts.rejectedAt) parts.push(`The claim was rejected on ${stamp(ts.rejectedAt)}.`);
  if (ts.settledAt) parts.push(`Settlement of ${rupees(c.paidAmount)} completed on ${stamp(ts.settledAt)}.`);
  if (ts.closedAt) parts.push(`The claim file was closed on ${stamp(ts.closedAt)}.`);
  const docs = db.find('documents', (d) => d.entityType === 'healthClaim' && d.entityId === c.id).length;
  parts.push(`${docs} document(s) are on file.`);
  return { text: parts.join(' '), generatedFrom: 'claim timeline, request timestamps and document records', disclaimer: 'Generated summary for orientation only — not a claim decision.' };
}
