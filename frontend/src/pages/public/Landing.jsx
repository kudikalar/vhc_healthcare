import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { Alert, ErrorBox, Field, useAction, useLoad } from '../../components/ui.jsx';
import Icon from '../../components/Icon.jsx';
import CoverMeter from '../../components/CoverMeter.jsx';
import { money } from '../../format.js';
import { LegalNote, useT } from '../enterprise/i18n.jsx';
import '../enterprise/enterprise.css';

// Public website (§1). Only product capability, process and regulatory facts are shown — no invented
// customer counts, ratings, testimonials, partner logos or settlement statistics. The insurer catalogue
// lists only insurers the partners API marks publishable, each labelled sandbox where applicable.

const SECTIONS = [
  ['categories', 'Health insurance'], ['compare', 'Compare'], ['hospitals', 'Partner hospitals'], ['services', 'Health services'],
  ['claims', 'Claims assistance'], ['corporate', 'Corporate insurance'], ['about', 'About VHC'], ['contact', 'Contact & support'],
];

const CATEGORIES = [
  ['individual', 'Individual', 'user', 'Cover for one person with their own sum insured.'],
  ['family_floater', 'Family floater', 'family', 'One shared sum insured for your spouse, children and (if eligible) parents.'],
  ['senior_citizen', 'Senior citizen', 'shield', 'Plans designed for people aged 60+, with clear co-pay and waiting-period terms.'],
  ['top_up', 'Top-up', 'layers', 'Extra cover that pays once a single claim crosses a deductible.'],
  ['super_top_up', 'Super top-up', 'layers', 'Extra cover that pays once your total claims in a year cross the deductible.'],
  ['critical_illness', 'Critical illness', 'stethoscope', 'A lump sum on diagnosis of a listed serious illness, as defined in the policy.'],
  ['personal_accident', 'Personal accident', 'alert', 'Cover for accidental death and disability, as defined in the policy.'],
  ['group_medical', 'Group medical', 'building', 'Employer-provided cover for employees and their dependants.'],
];

const WHY = [
  ['scale', 'Neutral comparison', 'Plans are listed by your filters, never by the commission an insurer pays. Exclusions and waiting periods are shown before price.'],
  ['shield', 'Licensed insurers only', 'Every product names the insurer that issues it and its product identification number (UIN). VHC does not issue insurance.'],
  ['file', 'Your terms, frozen', 'Your policy keeps the exact version you bought. Later product changes never rewrite it.'],
  ['user', 'Private by default', 'Medical documents are access-checked and every download is logged. You can export or delete your data.'],
];

const BUY_STEPS = [
  ['Compare', 'Filter by need and budget; read inclusions, exclusions, waiting periods, co-pay and room-rent limits side by side.'],
  ['Get a quote', 'The premium is calculated from the insurer\'s filed rates for your members, ages and sum insured.'],
  ['Apply and disclose', 'Answer health questions honestly — non-disclosure can lead to claim rejection. Upload documents securely.'],
  ['Pay securely', 'Pay through the payment gateway. Payment confirmation and policy issuance are separate steps.'],
  ['Insurer issues the policy', 'The insurer reviews and issues the policy, or declines with a full refund. You get the schedule and CIS in your account.'],
];

const CLAIM_STEPS = [
  ['Emergency? Get care first', 'Call 112 or go to the nearest hospital. Claims can be raised afterwards.'],
  ['Cashless at a network hospital', 'The hospital requests pre-authorisation from the insurer/TPA; approval is provisional until the final bill.'],
  ['Reimbursement', 'Pay the hospital, then upload bills, reports and the discharge summary. We show exactly what is still needed.'],
  ['Track every step', 'See who acts next, every deduction with its reason, and the payout status.'],
];

const FAQ = [
  ['Is VHC an insurance company?', 'No. VHC is a technology platform. Insurance is solicited and issued only by the licensed insurer named on each product, and claims are decided by that insurer (or its TPA).'],
  ['Can I buy a real policy on this site?', 'Not on this staging site. It is a sandbox: products, insurers and hospitals are synthetic, and no real payment is taken.'],
  ['What is a waiting period?', 'A period after your cover starts during which some conditions (for example pre-existing diseases) are not covered. Each product states its waiting periods in the Customer Information Sheet (CIS).'],
  ['Is a network hospital guaranteed to approve cashless treatment?', 'No. A network hospital can request cashless authorisation, which the insurer reviews. Approval is provisional until the final bill is assessed.'],
  ['How do I complain?', 'For help, raise a support ticket. For a formal complaint about VHC, use Grievances. For decisions on cover or claims, complain to the insurer; if unresolved, you can approach IRDAI\'s Bima Bharosa system or the Insurance Ombudsman.'],
];

const CITIES = ['Bengaluru', 'Chennai', 'Delhi', 'Hyderabad', 'Kolkata', 'Mumbai', 'Pune', 'Other'];
const SUMS = [[500000, '₹5 lakh'], [1000000, '₹10 lakh'], [1500000, '₹15 lakh'], [2500000, '₹25 lakh'], [5000000, '₹50 lakh'], [10000000, '₹1 crore']];
const INTERESTS = [['health_individual', 'Health insurance for me'], ['health_family', 'Family health insurance'], ['senior', 'Senior citizen cover'], ['corporate', 'Group / corporate cover'], ['claims_help', 'Help with a claim'], ['other', 'Something else']];

/** The home page's one memorable element: how a shared family floater is actually used up. */
function HeroMeter() {
  const t = useT();
  const L = 100000 * 100;
  const family = [
    ['AR', 'Anil', 'self', null],
    ['KR', 'Kavya', 'spouse', ['paid', 120000 * 100, 'Dengue — hospitalised 4 days']],
    ['IR', 'Ira', 'child', null],
    ['SR', 'Shanta', 'mother', ['held', 85000 * 100, 'Cataract surgery — cashless pre-authorised']],
  ];
  return (
    <div className="hero-meter">
      <header><strong>{t('Family floater, ₹10 lakh')}</strong><span>{t('Illustrative example')}</span></header>
      <CoverMeter total={10 * L} paid={120000 * 100} reserved={85000 * 100} sharedBy={4} size="lg" animate />
      <ul className="hero-family" aria-label={t('Who is covered')}>
        {family.map(([ini, name, rel, claim]) => (
          <li key={name}>
            <span className="avatar" aria-hidden="true">{ini}</span>
            <span>{name} <span className="muted">· {t(rel)}</span>{claim && <span className={`note ${claim[0] === 'held' ? 'held' : ''}`}>{claim[2]}</span>}</span>
            <span className="amt">{claim ? `${claim[0] === 'held' ? t('held') : t('paid')} ${money(claim[1])}` : '—'}</span>
          </li>
        ))}
      </ul>
      <p className="muted" style={{ fontSize: '.86rem', margin: '1rem 0 0' }}>{t('One sum insured covers all four. Each claim reduces what is left for everyone until renewal — VHC shows this on every family policy.')}</p>
    </div>
  );
}

function Estimate() {
  const t = useT();
  const nav = useNavigate();
  const [f, setF] = useState({ age: '35', members: '2', city: 'Hyderabad', sumInsured: '1000000' });
  const ok = Number(f.age) >= 18 && Number(f.age) <= 99;
  return (
    <form className="lpx-estimate" aria-labelledby="est-h" onSubmit={(e) => { e.preventDefault(); if (ok) nav(`/quote?${new URLSearchParams({ product: 'health', ...f })}`); }}>
      <div>
        <h2 id="est-h">{t('Quick premium estimate')}</h2>
        <p className="hint2" style={{ margin: 0 }}>{t('Calculated on the next page with the insurer\'s rating rules. Nothing you enter here is stored.')}</p>
      </div>
      <div className="form-grid">
        <Field label={t('Age of eldest member')}><input type="number" min="18" max="99" inputMode="numeric" value={f.age} onChange={(e) => setF({ ...f, age: e.target.value })} aria-invalid={!ok} /></Field>
        <Field label={t('Members')}><select value={f.members} onChange={(e) => setF({ ...f, members: e.target.value })}>{[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}</option>)}</select></Field>
        <Field label={t('City')}><select value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })}>{CITIES.map((c) => <option key={c}>{c}</option>)}</select></Field>
        <Field label={t('Sum insured')}><select value={f.sumInsured} onChange={(e) => setF({ ...f, sumInsured: e.target.value })}>{SUMS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
        <button className="btn" disabled={!ok}>{t('See my estimate')}</button>
      </div>
    </form>
  );
}

function Callback() {
  const t = useT();
  const [f, setF] = useState({ name: '', mobile: '', email: '', city: '', interest: 'health_family', consent: false });
  const [done, setDone] = useState(null);
  const act = useAction();
  const fe = act.error instanceof ApiError ? act.error.fields : {};
  const unavailable = act.error instanceof ApiError && [404, 501, 503].includes(act.error.status);
  const submit = (e) => {
    e.preventDefault();
    if (!f.consent) { act.setError(new Error('Please tick the consent box so we may call you.')); return; }
    act.run(async () => {
      const r = await api.post('/partners/leads', { name: f.name.trim(), mobile: f.mobile.trim(), email: f.email.trim() || undefined, city: f.city.trim() || undefined, interest: f.interest, consent: true });
      setDone(r);
    });
  };
  if (done) return <Alert kind="ok"><strong>Thank you.</strong> Your callback request{done.reference ? ` ${done.reference}` : ''} has been received. In this sandbox no real call is made.</Alert>;
  return (
    <form id="callback" onSubmit={submit} aria-labelledby="cb-h" className="card" style={{ margin: 0 }}>
      <h3 id="cb-h">{t('Request a callback')}</h3>
      <div className="form-grid">
        <Field label={t('Name')} error={fe.name}><input required maxLength={80} autoComplete="name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label={t('Mobile number')} error={fe.mobile}><input required inputMode="tel" autoComplete="tel" pattern="[0-9+\s-]{10,15}" value={f.mobile} onChange={(e) => setF({ ...f, mobile: e.target.value })} /></Field>
        <Field label={t('Email (optional)')} error={fe.email}><input type="email" autoComplete="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label={t('City')}><input value={f.city} maxLength={60} onChange={(e) => setF({ ...f, city: e.target.value })} /></Field>
        <Field label={t('I am interested in')} className="full"><select value={f.interest} onChange={(e) => setF({ ...f, interest: e.target.value })}>{INTERESTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
        <label className="check full"><input type="checkbox" checked={f.consent} onChange={(e) => setF({ ...f, consent: e.target.checked })} /> <span>I agree that Vision Health Care may contact me by phone or email about this request. I can withdraw this consent at any time. This is not a request for marketing.</span></label>
      </div>
      {unavailable ? <Alert kind="warn">Callback requests are not available right now. Please email us or, if you have an account, raise a support ticket.</Alert> : <ErrorBox error={act.error} />}
      <button className="btn" style={{ marginTop: '.8rem' }} disabled={act.busy}>{act.busy ? 'Sending…' : t('Request callback')}</button>
    </form>
  );
}

function Insurers() {
  const res = useLoad(() => api.get('/partners/public/insurers').catch((e) => (e instanceof ApiError && e.status === 404 ? null : Promise.reject(e))));
  if (res.loading) return <p className="muted">Loading insurers…</p>;
  if (res.error || res.data == null) return <p className="muted">The insurer catalogue will appear here once insurer partners are published. Every product always names the insurer that issues it.</p>;
  if (!res.data.length) return <p className="muted">No insurers are published yet.</p>;
  return (
    <div className="lpx-insurers">
      {res.data.map((i) => (
        <div key={i.id} className="lpx-insurer">
          <div className="row between"><strong>{i.name}</strong>{i.sandbox && <span className="badge warn">Sandbox · synthetic</span>}</div>
          <p className="muted" style={{ margin: '.3rem 0 0', fontSize: '.88rem' }}>{i.type || 'Insurer'}{i.sandbox ? ' — a test entity for this staging site, not a real company.' : ''}</p>
          <Link to={`/plans?insurer=${encodeURIComponent(i.id)}`} style={{ fontSize: '.88rem' }}>View products →</Link>
        </div>
      ))}
    </div>
  );
}

const IRDAI_STATUS = { pending: 'Pending', not_applicable: 'Not applicable', registered: 'Registered' };

export default function Landing() {
  const t = useT();
  const nav = useNavigate();
  const { user } = useAuth();
  const cfg = useLoad(() => api.get('/enterprise/public/config').catch(() => null));
  const kb = useLoad(() => api.get('/enterprise/support/kb').catch(() => []));
  const [hs, setHs] = useState({ city: '', specialty: '' });
  const c = cfg.data;

  return (
    <div className="landing">
      <nav className="lpx-subnav" aria-label="Sections">
        <ul>{SECTIONS.map(([id, label]) => <li key={id}><a href={`#${id}`}>{t(label)}</a></li>)}</ul>
      </nav>

      <section className="lp-hero" aria-labelledby="hero-h">
        <div className="lp-container lp-hero-grid">
          <div className="lp-hero-copy">
            <span className="lp-kicker"><Icon name="shield" size={16} /> {t('Sandbox · no live insurance sales')}</span>
            <h1 id="hero-h">{t('Health insurance, explained honestly.')}</h1>
            <p className="lp-lead">{t('Compare plans from licensed insurers side by side, see exclusions and waiting periods before you buy, and get help with cashless treatment and claims.')}</p>
            <div className="lpx-hero-ctas">
              <Link className="btn lg" to="/plans">{t('Find health insurance')}</Link>
              <Link className="btn lg ghost-light" to="/plans">{t('Compare plans')}</Link>
            </div>
            <div className="lp-hero-links">
              <Link to="/hospitals">{t('Find a hospital')}</Link>
              <a href="#callback">{t('Request a callback')}</a>
            </div>
            <ul className="lp-ticks">
              <li><Icon name="scale" size={18} /> {t('No commission-based ranking')}</li>
              <li><Icon name="file" size={18} /> {t('Exclusions shown first')}</li>
              <li><Icon name="shield" size={18} /> {t('Insurer named on every product')}</li>
            </ul>
          </div>
          <HeroMeter />
        </div>
      </section>

      <section className="estimate-band" aria-label={t('Quick premium estimate')}>
        <div className="lp-container"><Estimate /></div>
      </section>

      <section id="categories" className="lp-section" aria-labelledby="cat-h">
        <div className="lp-container">
          <div className="lp-head"><h2 id="cat-h">{t('Health insurance categories')}</h2><p>Pick a category to see matching products. Product availability depends on the insurers published on the platform.</p></div>
          <div className="lpx-cats">
            {CATEGORIES.map(([cat, label, icon, text]) => (
              <Link key={cat} className="lpx-cat" to={`/plans?category=${cat}`}>
                <span className="ic"><Icon name={icon} /></span>
                <h3>{t(label)}</h3>
                <p>{text}</p>
                <span className="cat-go">{t('See plans')}</span>
              </Link>
            ))}
          </div>
        </div>
      </section>

      <section id="compare" className="lp-section lp-alt" aria-labelledby="ins-h">
        <div className="lp-container">
          <div className="lp-head row between" style={{ alignItems: 'flex-end' }}>
            <div><h2 id="ins-h">{t('Insurer catalogue')}</h2><p>Only insurers with a published listing appear here. Sandbox entities are synthetic and clearly labelled.</p></div>
            <Link className="btn secondary" to="/plans">{t('Compare plans')}</Link>
          </div>
          <Insurers />
        </div>
      </section>

      <section className="lp-section lpx-light" aria-labelledby="why-h">
        <div className="lp-container lpx-two">
          <div>
            
            <h2 id="why-h">{t('Why VHC')}</h2>
            <div className="lp-principles">
              {WHY.map(([ic, title, d]) => <div key={title} className="principle"><span className="ic"><Icon name={ic} /></span><div><strong>{title}</strong><p>{d}</p></div></div>)}
            </div>
          </div>
          <div>
            
            <h2>{t('How buying works')}</h2>
            <ol className="lpx-steps">{BUY_STEPS.map(([title, d]) => <li key={title}><strong>{title}</strong><span>{d}</span></li>)}</ol>
          </div>
        </div>
      </section>

      <section id="hospitals" className="lp-section lp-alt" aria-labelledby="hos-h">
        <div className="lp-container lpx-two">
          <div>
            
            <h2 id="hos-h">{t('Cashless hospital search')}</h2>
            <p>Find hospitals in your insurer's cashless network by city and specialty. A listing means the hospital can request cashless authorisation — it is not a guarantee of approval. Hospitals shown on this staging site are fictional.</p>
          </div>
          <form className="card" style={{ margin: 0 }} onSubmit={(e) => { e.preventDefault(); nav(`/hospitals?${new URLSearchParams(Object.entries(hs).filter(([, v]) => v))}`); }} aria-label={t('Cashless hospital search')}>
            <div className="form-grid">
              <Field label={t('City')}><input value={hs.city} onChange={(e) => setHs({ ...hs, city: e.target.value })} placeholder="e.g. Chennai" /></Field>
              <Field label={t('Specialty')}><input value={hs.specialty} onChange={(e) => setHs({ ...hs, specialty: e.target.value })} placeholder="e.g. Cardiology" /></Field>
            </div>
            <button className="btn" style={{ marginTop: '.8rem' }}>{t('Search hospitals')}</button>
          </form>
        </div>
      </section>

      <section id="claims" className="lp-section" aria-labelledby="clm-h">
        <div className="lp-container lpx-two">
          <div>
            
            <h2 id="clm-h">{t('How we help with claims')}</h2>
            <p>Claims are decided by the insurer (or its TPA). VHC helps you file complete claims, track them and understand every deduction.</p>
            <div className="row"><Link className="btn" to="/support#claim-help">{t('Claim help')}</Link><Link className="btn secondary" to="/life-claim">{t('Report a life claim')}</Link></div>
          </div>
          <ol className="lpx-steps">{CLAIM_STEPS.map(([title, d]) => <li key={title}><strong>{title}</strong><span>{d}</span></li>)}</ol>
        </div>
      </section>

      <section id="services" className="lp-section lp-alt" aria-labelledby="svc-h">
        <div className="lp-container lpx-two">
          <div>
            
            <h2 id="svc-h">{t('Health services booking')}</h2>
            <p>Book consultations, diagnostics and health check-ups with partner providers. Service fees, where charged, are shown before you confirm and are separate from insurance premium.</p>
            <Link className="btn secondary" to="/services">{t('Health services')}</Link>
          </div>
          <div id="corporate">
            
            <h2>{t('For employers')}</h2>
            <p>Group medical cover administration: employee enrolment, dependants, endorsements and claims support, with HR seeing only aggregate information — never an employee's medical details.</p>
            <div className="row"><Link className="btn secondary" to="/benefits">{t('Employee benefits')}</Link><a className="btn ghost" href="#callback">{t('Request a callback')}</a></div>
          </div>
        </div>
      </section>

      <section className="lp-section" aria-labelledby="edu-h">
        <div className="lp-container">
          <div className="lp-head"><h2 id="edu-h">{t('Learn about health insurance')}</h2></div>
          <div className="lpx-articles">
            {(kb.data || []).map((a) => <Link key={a.slug} className="lpx-cat" to={`/support/kb/${a.slug}`}><span className="ent-pill">{a.category}</span><h3>{a.title}</h3><p>{a.summary}</p></Link>)}
          </div>
          <h2 style={{ marginTop: '2rem' }}>{t('Frequently asked questions')}</h2>
          <div className="card faq">{FAQ.map(([q, a]) => <details key={q}><summary>{q}</summary><p>{a}</p></details>)}</div>
        </div>
      </section>

      <section id="contact" className="lp-section lp-alt" aria-labelledby="ct-h">
        <div className="lp-container lpx-two">
          <div id="about">
            
            <h2>{t('About VHC')}</h2>
            <p>{c?.role || 'VHC is a technology platform. Insurance is solicited and issued only by the licensed entities named on each product.'}</p>
            <h2 id="ct-h" style={{ marginTop: '1.5rem' }}>{t('Contact & support')}</h2>
            <dl className="kv">
              <dt>Email</dt><dd>{c?.contact.email || '—'}</dd>
              <dt>Phone</dt><dd>{c?.contact.phone || '—'}</dd>
              <dt>Hours</dt><dd>{c?.contact.hours || '—'}</dd>
              <dt>Grievance officer</dt><dd>{c ? `${c.grievanceOfficer.name} · ${c.grievanceOfficer.email}` : '—'}</dd>
            </dl>
            <div className="row" style={{ marginTop: '.8rem' }}><Link className="btn secondary" to="/support">{t('Support')}</Link><Link className="btn ghost" to="/support/kb">{t('Knowledge base')}</Link></div>
          </div>
          <Callback />
        </div>
      </section>

      <section className="lp-section lpx-disclosure" aria-labelledby="disc-h">
        <div className="lp-container">
          <h2 id="disc-h">{t('Regulatory disclosures')}</h2>
          <LegalNote />
          <dl lang="en">
            <dt>Legal role</dt><dd>{c?.role || 'VHC is a technology platform and is not an insurer.'}</dd>
            <dt>Who issues insurance</dt><dd>Insurance is solicited and issued only by the licensed insurer (and, where applicable, the licensed intermediary) named on each product page, together with the product's UIN. Claims are decided by the insurer or its TPA.</dd>
            <dt>IRDAI registration</dt><dd>{c ? <>{IRDAI_STATUS[c.irdai.status] || c.irdai.status}{c.irdai.registrationNo ? ` — ${c.irdai.category ? `${c.irdai.category}, ` : ''}registration no. ${c.irdai.registrationNo}${c.irdai.validTill ? `, valid till ${c.irdai.validTill}` : ''}` : ''}. {c.irdai.note}</> : 'Pending / not applicable.'}</dd>
            <dt>Environment</dt><dd>{c?.environmentNote || 'Staging / sandbox: no live insurance sales and no real payments.'}</dd>
            <dt>Statistics and reviews</dt><dd>This site shows no customer counts, claim-settlement ratios, ratings or testimonials. Where official ratios are shown in future they will cite the source and period.</dd>
            <dt>Insurance is the subject matter of solicitation</dt><dd>Read the policy wording, Customer Information Sheet and prospectus carefully before buying. Premiums depend on the insurer's underwriting.</dd>
            <dt>Complaints</dt><dd>Support tickets and VHC grievances are handled in your account. For insurance decisions contact the insurer's grievance officer; if unresolved, use IRDAI's Bima Bharosa system or the Insurance Ombudsman.</dd>
          </dl>
          {user && <p className="muted" style={{ marginTop: '1rem' }}>Signed in as {user.name}.</p>}
        </div>
      </section>
    </div>
  );
}
