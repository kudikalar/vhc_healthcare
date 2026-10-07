import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import Icon from './Icon.jsx';

// Vision AI: cited policy explainer (VHC-M30). Conversations live only in this browser tab's memory.
const SUGGESTIONS = [
  'What is not covered by my health policy?',
  'How much would I get for a ₹1,00,000 hospital bill?',
  'Are there waiting periods for diabetes?',
  'Who are my nominees?',
  'When is my next premium due?',
  'What happens if I miss a premium?',
];

function useStatus() {
  const [s, setS] = useState(null);
  useEffect(() => { api.get('/ai/status', { quiet401: true }).then(setS).catch(() => {}); }, []);
  return s;
}

function Answer({ m }) {
  const [open, setOpen] = useState(false);
  const parts = m.content.split(/(\[[A-Z]\d+(?:-[a-z]+)?\])/g);
  return (
    <div className={`ai-msg bot ${m.urgent ? 'urgent-msg' : ''}`}>
      <div className="ai-text">
        {parts.map((p, i) => {
          const id = /^\[([A-Z]\d+(?:-[a-z]+)?)\]$/.exec(p)?.[1];
          return id ? <button key={i} type="button" className="cite" onClick={() => setOpen(id)} title="Show source">{id}</button> : <span key={i}>{p}</span>;
        })}
      </div>
      {m.notice && <div className="ai-notice">{m.notice}</div>}
      {m.evidence?.length > 0 && (
        <div className="ai-sources">
          <span className="muted">Sources</span>
          {m.evidence.map((e) => (
            <button key={e.id} type="button" className={`src-chip ${open === e.id ? 'on' : ''}`} onClick={() => setOpen(open === e.id ? false : e.id)}>{e.title}</button>
          ))}
          {open && m.evidence.find((e) => e.id === open) && (
            <blockquote className="ai-quote">
              <strong>{m.evidence.find((e) => e.id === open).source}</strong>
              {m.evidence.find((e) => e.id === open).text}
            </blockquote>
          )}
        </div>
      )}
      {m.abstained && <Link className="ai-escalate" to="/support">Talk to support instead →</Link>}
    </div>
  );
}

export function AssistantChat({ compact = false, policyId: fixedPolicy }) {
  const status = useStatus();
  const [policies, setPolicies] = useState([]);
  const [policyId, setPolicyId] = useState(fixedPolicy || '');
  const [msgs, setMsgs] = useState([]);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const end = useRef();
  const input = useRef();

  useEffect(() => { api.get('/policies', { quiet401: true }).then(setPolicies).catch(() => {}); }, []);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [msgs, busy]);

  const ask = async (text) => {
    const question = (text ?? q).trim();
    if (!question || busy) return;
    const history = msgs.map((m) => ({ role: m.role, content: m.content }));
    setMsgs((x) => [...x, { role: 'user', content: question }]);
    setQ('');
    setBusy(true);
    try {
      const r = await api.post('/ai/ask', { question, policyId: policyId || undefined, history });
      setMsgs((x) => [...x, { role: 'assistant', content: r.answer, evidence: r.evidence, abstained: r.abstained, urgent: r.urgent, notice: r.notice, mode: r.mode }]);
    } catch (e) {
      setMsgs((x) => [...x, { role: 'assistant', content: e.message || 'Something went wrong. Please try again.', abstained: true }]);
    } finally {
      setBusy(false);
      input.current?.focus();
    }
  };

  return (
    <div className={`ai-chat ${compact ? 'compact' : ''}`}>
      <div className="ai-toolbar">
        <span className={`ai-engine ${status?.engine === 'claude' ? 'live' : ''}`} title={status?.model || 'Answers built directly from your policy records'}>
          <span className="pulse" /> {status?.engine === 'claude' ? 'Claude AI' : 'Policy records mode'}
        </span>
        {!fixedPolicy && policies.length > 1 && (
          <select value={policyId} onChange={(e) => setPolicyId(e.target.value)} aria-label="Policy to ask about">
            <option value="">All my policies</option>
            {policies.map((p) => <option key={p.id} value={p.id}>{p.planName} · {p.policyNumber}</option>)}
          </select>
        )}
      </div>
      <div className="ai-log" aria-live="polite">
        {msgs.length === 0 && (
          <div className="ai-empty">
            <div className="ai-orb" aria-hidden="true"><Icon name="help" size={26} /></div>
            <h3>Ask about your cover</h3>
            <p>Answers come only from your purchased policy and are linked to their source. Vision AI can't approve claims, change premiums or give medical advice.</p>
            <div className="ai-suggest">
              {SUGGESTIONS.slice(0, compact ? 4 : 6).map((s) => <button key={s} type="button" onClick={() => ask(s)}>{s}</button>)}
            </div>
          </div>
        )}
        {msgs.map((m, i) => (m.role === 'user' ? <div key={i} className="ai-msg me">{m.content}</div> : <Answer key={i} m={m} />))}
        {busy && <div className="ai-msg bot typing" aria-label="Vision AI is answering"><i /><i /><i /></div>}
        <div ref={end} />
      </div>
      <form className="ai-input" onSubmit={(e) => { e.preventDefault(); ask(); }}>
        <textarea ref={input} rows={1} value={q} maxLength={4000} placeholder="Ask in English, हिन्दी or తెలుగు…" aria-label="Your question"
          onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); } }} />
        <button className="btn" disabled={busy || !q.trim()} aria-label="Send">Ask</button>
      </form>
      <p className="ai-foot">AI answers can be wrong. Your policy document is the authority. In an emergency, get care first.</p>
    </div>
  );
}

/** Floating launcher available to signed-in customers on every page except the full assistant page. */
export default function AssistantLauncher() {
  const { user } = useAuth();
  const loc = useLocation();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return undefined;
    const esc = (e) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [open]);
  if (user?.role !== 'customer' || loc.pathname === '/assistant') return null;
  return (
    <>
      {open && (
        <div className="ai-panel" role="dialog" aria-label="Vision AI assistant">
          <div className="ai-panel-head">
            <span className="row"><span className="ai-dot" /> <strong>Vision AI</strong></span>
            <span className="row">
              <Link to="/assistant" className="icon-btn" aria-label="Open full screen" title="Open full screen" onClick={() => setOpen(false)}><Icon name="explore" size={18} /></Link>
              <button className="icon-btn" aria-label="Close assistant" onClick={() => setOpen(false)}><Icon name="close" size={18} /></button>
            </span>
          </div>
          <AssistantChat compact />
        </div>
      )}
      <button className={`ai-fab ${open ? 'hidden' : ''}`} onClick={() => setOpen(true)} aria-label="Ask Vision AI">
        <span className="ai-dot" /> <span>Ask Vision AI</span>
      </button>
    </>
  );
}
