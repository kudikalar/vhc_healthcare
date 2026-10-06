// VHC-M05 customer dashboard: KPIs, policy cards, action queue and activity timeline.
// Every figure is derived from the same bucket definitions as the lists it links to.
import { Router } from 'express';
import { db } from '../db.js';
import { today } from '../clock.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { bad } from '../utils/errors.js';
import { addDays, isValidDate } from '../utils/dates.js';
import { sum } from '../utils/money.js';
import { policyStatusAt } from '../services/lifecycle.js';
import { available } from '../services/settlement.js';
import { BUCKETS, nextUnpaid } from '../services/buckets.js';
import { profileChecklist } from '../services/profile.js';

const r = Router();
r.use(authenticate, requireRole('customer'));

function section(errors, name, fn, fallback) {
  try {
    return fn();
  } catch (e) {
    console.error(`dashboard section ${name} failed`, e);
    errors.push(name);
    return fallback;
  }
}

r.get('/', (req, res) => {
  const { product = 'all' } = req.query;
  if (!['all', 'health', 'life'].includes(product)) throw bad('Choose a valid product.');
  const to = req.query.to || today();
  const from = req.query.from || addDays(to, -30);
  if (!isValidDate(from) || !isValidDate(to)) throw bad('Enter valid dates.');
  if (to < from) throw bad('End date must be on or after start.');

  const uid = req.user.id;
  const byProduct = (x) => product === 'all' || x.product === product;
  const policies = db.find('policies', (p) => p.userId === uid).filter(byProduct);
  const apps = db.find('applications', (a) => a.userId === uid).filter(byProduct);
  const claims = product === 'life' ? [] : db.find('healthClaims', (c) => c.userId === uid);
  const errors = [];

  const kpis = section(errors, 'kpis', () => {
    const due = policies.filter(BUCKETS.policies.due);
    return {
      activePolicies: { count: policies.filter(BUCKETS.policies.active).length, link: '/policies?bucket=active' },
      pendingApplications: { count: apps.filter(BUCKETS.applications.pending).length, link: '/applications?bucket=pending' },
      openClaims: { count: claims.filter(BUCKETS.claims.open).length, link: '/claims?bucket=open' },
      premiumsDue: { count: due.length, amount: sum(due, (p) => nextUnpaid(p).amount), link: '/policies?bucket=due' },
    };
  }, null);

  const policyCards = section(errors, 'policies', () => policies.map((p) => {
    const status = policyStatusAt(p);
    const card = { id: p.id, policyNumber: p.policyNumber, planName: p.planName, product: p.product, status, startDate: p.startDate, endDate: p.endDate };
    if (p.product === 'health') {
      Object.assign(card, { coverage: p.coverage, availableCoverage: available(p), shared: p.planType === 'floater', members: p.members.length });
    } else {
      const n = nextUnpaid(p);
      Object.assign(card, { sumAssured: p.sumAssured, nextDue: n ? { no: n.no, dueDate: n.dueDate, amount: n.amount, graceEnds: addDays(n.dueDate, p.graceDays) } : null });
    }
    return card;
  }).sort((a, b) => a.status.localeCompare(b.status)), []);

  const actions = section(errors, 'actions', () => {
    const list = [];
    const u = db.get('users', uid);
    const missing = profileChecklist(u).filter((c) => c.required && !c.ok);
    if (missing.length) list.push({ kind: 'profile', priority: 2, title: 'Complete your profile', detail: missing.map((m) => m.label).join(', '), link: '/profile' });
    if (!u.mobileVerified) list.push({ kind: 'mobile', priority: 3, title: 'Verify your mobile number', detail: 'Needed before claim payouts and SMS updates.', link: '/profile?tab=security' });
    for (const a of apps) {
      const map = {
        Draft: [3, 'Continue your application', 'Saved as a draft'],
        'More Information Required': [1, 'Information requested', 'Underwriting needs more information'],
        Approved: [1, a.offer?.revised ? 'Review revised terms' : 'Review and accept your offer', `Offer valid until ${a.offer?.expiresAt}`],
        'Offer Accepted': [1, 'Complete your payment', 'Pay the first premium to issue the policy'],
      }[a.status];
      if (map) list.push({ kind: 'application', priority: map[0], title: map[1], detail: `${a.applicationNumber} · ${a.planName} — ${map[2]}`, link: `/applications/${a.id}`, product: a.product });
    }
    for (const p of policies) {
      const status = policyStatusAt(p);
      if (p.product === 'life' && BUCKETS.policies.due(p)) {
        const n = nextUnpaid(p);
        list.push({ kind: 'payment', priority: status === 'Active' ? 2 : 0, title: status === 'Lapsed' ? 'Policy lapsed — request reinstatement' : status === 'Grace Period' ? 'Premium overdue' : 'Premium due', detail: `${p.policyNumber}: installment ${n.no} due ${n.dueDate}`, amount: n.amount, link: `/policies/${p.id}?tab=schedule`, product: 'life' });
      }
      if (p.product === 'health' && !p.renewedBy) {
        const opens = addDays(p.endDate, -(p.termsSnapshot.renewalWindowDays ?? 60));
        const closes = addDays(p.endDate, p.termsSnapshot.renewalGraceDays ?? 30);
        if (today() >= opens && today() <= closes) list.push({ kind: 'renewal', priority: 2, title: 'Renewal due', detail: `${p.policyNumber} ends ${p.endDate}`, link: `/policies/${p.id}`, product: 'health' });
      }
    }
    for (const c of claims) {
      if (c.status === 'Documents Requested') list.push({ kind: 'claim', priority: 1, title: 'Upload claim documents', detail: `${c.claimNumber}: ${c.documentRequests.filter((d) => !d.resolved).map((d) => d.note).join('; ')}`, link: `/claims/${c.id}`, product: 'health' });
      if (c.status === 'Preauth Approved') list.push({ kind: 'claim', priority: 2, title: 'Submit the final hospital bill', detail: c.claimNumber, link: `/claims/${c.id}`, product: 'health' });
    }
    return list.sort((a, b) => a.priority - b.priority);
  }, []);

  const activity = section(errors, 'activity', () => {
    const ev = [];
    const inRange = (at) => at && at.slice(0, 10) >= from && at.slice(0, 10) <= to;
    for (const a of apps) for (const t of a.timeline) {
      if (inRange(t.at)) ev.push({ at: t.at, product: a.product, type: 'application', title: `${a.applicationNumber}: ${t.status}`, detail: t.note, link: `/applications/${a.id}` });
    }
    for (const c of claims) for (const t of c.timeline) {
      if (inRange(t.at)) ev.push({ at: t.at, product: 'health', type: 'claim', title: `${c.claimNumber}: ${t.status}`, detail: t.note, link: `/claims/${c.id}` });
    }
    const policyIds = new Set(policies.map((p) => p.id));
    const appIds = new Set(apps.map((a) => a.id));
    for (const p of db.find('payments', (x) => x.userId === uid && (policyIds.has(x.policyId) || appIds.has(x.applicationId)))) {
      const at = p.completedAt || p.createdAt;
      if (inRange(at) && p.status !== 'pending') ev.push({ at, product: policies.find((x) => x.id === p.policyId)?.product || apps.find((x) => x.id === p.applicationId)?.product, type: 'payment', title: `Payment ${p.status}`, detail: `${p.description} · ${p.reference}`, amount: p.amount, link: '/payments' });
    }
    for (const p of policies) for (const v of p.nomineeVersions || []) {
      if (v.verifiedAt && v.version > 1 && inRange(v.verifiedAt)) ev.push({ at: v.verifiedAt, product: 'life', type: 'policy', title: `${p.policyNumber}: nominees updated`, detail: `Version ${v.version} effective ${v.effectiveFrom}`, link: `/policies/${p.id}?tab=nominees` });
    }
    return ev.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 50);
  }, []);

  res.json({ asOf: today(), filters: { product, from, to }, kpis, policies: policyCards, actions, activity, partialErrors: errors });
});

export default r;
