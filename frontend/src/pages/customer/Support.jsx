import { useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../../auth.jsx';
import { Card, PageHeader } from '../../components/ui.jsx';
import Icon from '../../components/Icon.jsx';

// Support and claim help. Human help never depends on an assistant; this page routes people to the
// right journey. Formal grievances/appeals (VHC-M35) and support threads (M32) are later phases.

const FAQ = [
  ['Is a network hospital guaranteed to approve cashless treatment?', 'No. Being listed in the network means a hospital can request cashless authorisation. Each request is reviewed, and a pre-authorisation is provisional until the final bill is assessed.'],
  ['What is the difference between cashless and reimbursement?', 'With cashless, the network hospital asks us to approve costs before you are discharged and the approved amount is paid to the hospital. With reimbursement, you pay the hospital and then claim the eligible amount back with your bills and reports.'],
  ['Why might a claim be paid at less than the bill?', 'Your policy has a per-claim deductible and a co-payment percentage, and some items may be excluded or capped. Every deduction is listed with a reason on the claim page.'],
  ['How does a shared family floater work?', 'One sum insured is shared by everyone on the policy. An approved claim for one member reduces the balance available to all members for the rest of the policy year.'],
  ['What happens if I miss a life premium?', 'A grace period applies after the due date. If the premium is still unpaid when grace ends, the policy lapses. You can then request reinstatement, which is reviewed before cover is restored.'],
  ['Who should report a death claim?', 'A nominee or family member reports it through "Report a life claim". They do not need the policyholder\'s login, and they only see information about the case they reported.'],
];

export default function Support() {
  const { user } = useAuth();
  const loc = useLocation();
  useEffect(() => {
    if (loc.hash) document.getElementById(loc.hash.slice(1))?.scrollIntoView({ block: 'start' });
  }, [loc.hash]);

  return (
    <>
      <PageHeader title="Support" subtitle="Claim help, answers to common questions and how to reach us." />

      <div className="urgent" role="note">
        <Icon name="alert" size={22} />
        <div><strong>In a medical emergency, get care first.</strong> Go to the nearest hospital or call your local emergency number. You don't need claim approval before urgent treatment; claims can be raised afterwards.</div>
      </div>

      <section id="claim-help" aria-labelledby="claim-help-title">
        <div className="section-title"><Icon name="claim" /><h2 id="claim-help-title">Claim help</h2></div>
        <div className="help-grid">
          <Link className="help-card" to={user ? '/claims/new?type=cashless' : '/login'}>
            <span className="ic"><Icon name="hospital" /></span>
            <h3>Planned hospital stay</h3>
            <p>Request cashless pre-authorisation at a network hospital before admission.</p>
            <span className="go">Request cashless →</span>
          </Link>
          <Link className="help-card" to={user ? '/claims/new' : '/login'}>
            <span className="ic"><Icon name="file" /></span>
            <h3>Already paid the hospital</h3>
            <p>Claim reimbursement with your bills, prescriptions and discharge summary.</p>
            <span className="go">Start a reimbursement claim →</span>
          </Link>
          <Link className="help-card" to="/life-claim">
            <span className="ic"><Icon name="dove" /></span>
            <h3>Report a death claim</h3>
            <p>For nominees and family. No login of the policyholder is needed.</p>
            <span className="go">Report a life claim →</span>
          </Link>
          <Link className="help-card" to={user ? '/claims' : '/login'}>
            <span className="ic"><Icon name="clipboard" /></span>
            <h3>Track an existing claim</h3>
            <p>See the current stage, who needs to act next and any documents we've asked for.</p>
            <span className="go">View my claims →</span>
          </Link>
        </div>
      </section>

      <div className="grid grid-2" style={{ marginTop: '1rem' }}>
        <Card title="How a health claim works">
          <ol className="steps">
            <li><div><strong>Tell us about the treatment</strong>Choose the policy and insured member, the hospital and the dates.</div></li>
            <li><div><strong>Upload documents</strong>Bills, prescriptions, reports and the discharge summary.</div></li>
            <li><div><strong>We review</strong>If anything is missing we'll list exactly what we need and by when.</div></li>
            <li><div><strong>Decision and payout</strong>You'll see the approved amount, every deduction with its reason, and payout status.</div></li>
          </ol>
        </Card>
        <Card title="Documents to keep ready">
          <ul className="checklist">
            {['Original hospital bills and payment receipts', 'Discharge summary', 'Prescriptions and pharmacy bills', 'Investigation and lab reports', 'Photo ID of the insured member', 'Bank details of the account to be paid (verified before payout)'].map((t) => (
              <li key={t}><span style={{ color: 'var(--brand)' }}>✓</span>{t}</li>
            ))}
          </ul>
          <p className="muted" style={{ marginBottom: 0, fontSize: '.875rem' }}>PDF, JPG or PNG, up to 5 MB each. Blurred or cut-off images may need to be re-uploaded.</p>
        </Card>
      </div>

      <div className="section-title"><Icon name="help" /><h2>Common questions</h2></div>
      <Card className="faq">
        {FAQ.map(([qq, a]) => (
          <details key={qq}><summary>{qq}</summary><p>{a}</p></details>
        ))}
      </Card>

      <div className="section-title"><Icon name="phone" /><h2>Contact us</h2></div>
      <div className="help-grid">
        <div className="help-card">
          <span className="ic"><Icon name="bell" /></span>
          <h3>Updates on your records</h3>
          <p>Every request for information, decision and payment update is posted to your notifications.</p>
          {user && <Link className="go" to="/notifications">Open notifications →</Link>}
        </div>
        <div className="help-card">
          <span className="ic"><Icon name="phone" /></span>
          <h3>Phone and email</h3>
          <p>Support contact details are provided by the insurer that issues your policy. This demo has no live support line.</p>
        </div>
        <div className="help-card">
          <span className="ic"><Icon name="alert" /></span>
          <h3>Complaints and appeals</h3>
          <p>Disagree with a decision? A formal grievance and appeal centre is planned for a later release. For now, reply to the information request on your claim with any new evidence.</p>
        </div>
      </div>
    </>
  );
}
