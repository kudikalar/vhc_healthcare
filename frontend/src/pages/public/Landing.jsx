import { Link } from 'react-router-dom';
import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { ErrorBox, Loading, useLoad } from '../../components/ui.jsx';
import Icon from '../../components/Icon.jsx';
import { PlanGrid } from './Catalogue.jsx';

// Public home. Everything shown is product capability or fictional demo data — no invented customer
// counts, ratings, partner logos or settlement statistics.

const FEATURES = [
  { icon: 'help', title: 'Vision AI policy explainer', text: 'Ask anything about your cover in English, Hindi or Telugu. Every answer links to the exact clause it came from — and says so when it can\'t confirm.', to: '/assistant', tag: 'AI', wide: true },
  { icon: 'calc', title: 'Claim payout estimator', text: 'See what a bill would pay after deductible, co-pay and your live balance — with exclusions and waiting periods flagged.', to: '/claims/estimate', tag: 'AI' },
  { icon: 'family', title: 'Family floater, shown once', text: 'One shared balance for the whole family: available, reserved and settled — never counted four times.', to: '/family' },
  { icon: 'chart', title: 'Coverage needs planner', text: 'A transparent calculation of the life cover your family might need, with every assumption visible.', to: '/planner', tag: 'Planner' },
  { icon: 'hospital', title: 'Cashless network', text: 'Search network hospitals by city and specialty, then request cashless pre-authorisation.', to: '/hospitals' },
  { icon: 'dove', title: 'Compassionate life claims', text: 'Nominees report a claim without the policyholder\'s login and see only their own case.', to: '/life-claim' },
];

const STEPS = [
  ['Compare', 'Exclusions, waiting periods, deductible and co-pay side by side — not buried in a brochure.'],
  ['Quote', 'An instant, itemised premium calculated on the server from versioned rates.'],
  ['Apply & pay', 'Save as you go, upload documents securely, accept the exact offer you were shown.'],
  ['Claim with confidence', 'Track every stage, see who acts next and why each rupee was paid or deducted.'],
];

const PRINCIPLES = [
  ['shield', 'Your terms never change underneath you', 'Policies keep the exact version you bought, even when plans are updated.'],
  ['file', 'Every deduction explained', 'Claim settlements list each deduction with its reason, and they reconcile to the rupee.'],
  ['user', 'Private by default', 'Medical documents are private, access-checked on every download and audited.'],
  ['alert', 'AI with guardrails', 'Vision AI can\'t approve claims, change premiums, move money or give medical advice.'],
];

export default function Landing() {
  const plans = useLoad(() => api.get('/plans'));
  const { user } = useAuth();
  const startTo = user ? '/dashboard' : '/register';

  return (
    <div className="landing">
      <section className="lp-hero">
        <div className="lp-container lp-hero-grid">
          <div className="lp-hero-copy">
            <span className="lp-kicker"><span className="ai-dot" /> Health + term life, with an AI that cites its sources</span>
            <h1>Cover your family can <span className="grad">actually understand.</span></h1>
            <p className="lp-lead">Compare plans honestly, get an itemised quote in seconds, and ask Vision AI what your policy really covers. When you need to claim, see every step — and every rupee.</p>
            <div className="row lp-cta">
              <Link className="btn lg" to="/quote">Get an instant quote</Link>
              <Link className="btn lg ghost-light" to="/plans">Compare plans</Link>
            </div>
            <ul className="lp-ticks">
              <li><Icon name="shield" size={18} /> Exclusions shown first</li>
              <li><Icon name="file" size={18} /> Itemised pricing</li>
              <li><Icon name="help" size={18} /> Cited AI answers</li>
            </ul>
          </div>

          <div className="lp-visual" aria-hidden="true">
            <div className="mock mock-cover">
              <div className="mock-head"><span className="chip">Family floater</span><span className="mock-status">Active</span></div>
              <div className="mock-label">Available to your family</div>
              <div className="mock-amount">₹8,64,500</div>
              <div className="stacked-meter"><span className="paid" style={{ width: '9%' }} /><span className="reserved" style={{ width: '5%' }} /><span className="avail" style={{ width: '86%' }} /></div>
              <div className="mock-people">
                {['AV', 'VV', 'DV'].map((x) => <span key={x} className="avatar">{x}</span>)}
                <small>Shared by 3 members</small>
              </div>
            </div>
            <div className="mock mock-chat">
              <div className="mock-q">Is cataract surgery covered?</div>
              <div className="mock-a">
                Yes, as in-patient or day-care treatment — but cataract has a <b>730-day waiting period</b> from your cover start. <span className="cite">P1-waiting</span>
              </div>
              <div className="mock-src"><Icon name="file" size={14} /> Vision Family Floater · purchased v1</div>
            </div>
            <div className="mock mock-claim">
              <div className="mock-label">Claim HC-000014</div>
              <div className="mock-steps"><i className="done" /><i className="done" /><i className="now" /><i /></div>
              <small>Approved ₹85,500 · payout in progress</small>
            </div>
            <div className="lp-glow" />
            <small className="mock-caption">Product preview · fictional data</small>
          </div>
        </div>
      </section>

      <section className="lp-section">
        <div className="lp-container">
          <div className="lp-head">
            <span className="eyebrow">Built for clarity</span>
            <h2>Everything insurance should have been</h2>
            <p>Tools that answer the questions people actually have — before buying, while covered and when it matters most.</p>
          </div>
          <div className="bento">
            {FEATURES.map((f) => (
              <Link key={f.title} to={f.to} className={`bento-card ${f.wide ? 'wide' : ''}`}>
                <div className="row between"><span className="ic"><Icon name={f.icon} /></span>{f.tag && <span className={`chip ${f.tag === 'AI' ? 'ai' : ''}`}>{f.tag}</span>}</div>
                <h3>{f.title}</h3>
                <p>{f.text}</p>
                {f.wide && (
                  <div className="bento-chat">
                    <div className="mock-q">How much would I get for a ₹1,00,000 bill?</div>
                    <div className="mock-a">After the ₹5,000 deductible and 10% co-pay, about <b>₹85,500</b>, if the treatment is covered and your balance allows. <span className="cite">P1-costshare</span></div>
                  </div>
                )}
                <span className="go">Explore <Icon name="chevron" size={16} /></span>
              </Link>
            ))}
          </div>
        </div>
      </section>

      <section className="lp-section lp-alt">
        <div className="lp-container">
          <div className="lp-head">
            <span className="eyebrow">How it works</span>
            <h2>From first quote to settled claim</h2>
          </div>
          <ol className="lp-steps">
            {STEPS.map(([t, d], i) => (
              <li key={t}><span className="n">{String(i + 1).padStart(2, '0')}</span><h3>{t}</h3><p>{d}</p></li>
            ))}
          </ol>
        </div>
      </section>

      <section className="lp-section">
        <div className="lp-container">
          <div className="lp-head row between" style={{ alignItems: 'flex-end' }}>
            <div>
              <span className="eyebrow">Plans</span>
              <h2>Health and term life plans</h2>
              <p>Starting prices are illustrative; your quote is calculated for your family.</p>
            </div>
            <Link className="btn secondary" to="/plans">Compare side by side</Link>
          </div>
          {plans.loading ? <Loading /> : plans.error ? <ErrorBox error={plans.error} /> : <PlanGrid plans={plans.data} />}
        </div>
      </section>

      <section className="lp-section lp-dark">
        <div className="lp-container lp-ai-grid">
          <div>
            <span className="eyebrow light">Vision AI</span>
            <h2>An assistant that shows its work</h2>
            <p>Vision AI reads only your purchased policy — not a newer brochure, and never anyone else's records. Each statement links to its source passage, and when the policy doesn't say, it tells you instead of guessing.</p>
            <ul className="lp-list">
              <li>Explains exclusions, waiting periods, co-pay and riders</li>
              <li>Estimates payouts using your live balance</li>
              <li>Recognises emergencies and tells you to get care first</li>
              <li>Hands you to a person whenever you prefer</li>
            </ul>
            <Link className="btn lg light" to={user ? '/assistant' : '/login'}>Try Vision AI</Link>
          </div>
          <div className="lp-principles">
            {PRINCIPLES.map(([ic, t, d]) => (
              <div key={t} className="principle"><span className="ic"><Icon name={ic} /></span><div><strong>{t}</strong><p>{d}</p></div></div>
            ))}
          </div>
        </div>
      </section>

      <section className="lp-section">
        <div className="lp-container lp-final">
          <div>
            <h2>Not sure how much life cover you need?</h2>
            <p>Our planner shows the full calculation — debts, goals, years of support — so you can decide with your eyes open.</p>
          </div>
          <div className="row">
            <Link className="btn lg" to="/planner">Open the planner</Link>
            <Link className="btn lg secondary" to={startTo}>{user ? 'Go to my dashboard' : 'Create an account'}</Link>
          </div>
        </div>
      </section>
    </div>
  );
}
