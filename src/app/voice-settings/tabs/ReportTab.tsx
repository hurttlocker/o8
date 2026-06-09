'use client';

/**
 * Report Issue tab — a bug/request form that POSTs to o8's feedback endpoint
 * (`/api/feedback/report`, loopback-gated → reachable same-origin). Mirrors
 * Symon's Report Issue: type + summary + details, with submit status.
 */
import { useState, type CSSProperties } from 'react';
import {
  ACCENT, ACCENT_GLOW, DANGER_RED, GLASS_BG, GLASS_BG_HOVER, GLASS_BORDER_SUBTLE, OK_GREEN, SF,
  TEXT_PRIMARY, TEXT_TERTIARY, TRANS_FAST, ICONS,
} from '../tokens';
import { SectionCard, SectionTitle, SectionHint, Segmented, AccentButton, PAGE_TITLE_STYLE } from '../primitives';

const INPUT_BASE: CSSProperties = {
  width: '100%', boxSizing: 'border-box', height: 36, paddingLeft: 12, paddingRight: 12,
  background: GLASS_BG, border: `1px solid ${GLASS_BORDER_SUBTLE}`, borderRadius: 9,
  color: TEXT_PRIMARY, fontSize: 13, fontFamily: SF, outline: 'none',
  transition: `border-color ${TRANS_FAST}, box-shadow ${TRANS_FAST}`,
};
const TEXTAREA_BASE: CSSProperties = {
  ...INPUT_BASE, height: undefined, minHeight: 120, paddingTop: 11, paddingBottom: 11,
  lineHeight: 1.6, resize: 'vertical',
};
function focusStyle(f: boolean): CSSProperties {
  return f ? { borderColor: ACCENT, boxShadow: `0 0 0 2px ${ACCENT_GLOW}`, background: GLASS_BG_HOVER } : {};
}

type Status = 'idle' | 'sending' | 'sent' | 'error';

export default function ReportTab() {
  const [category, setCategory] = useState('bug');
  const [summary, setSummary] = useState('');
  const [details, setDetails] = useState('');
  const [fS, setFS] = useState(false);
  const [fD, setFD] = useState(false);
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState('');

  const submit = async () => {
    const message = [summary.trim(), details.trim()].filter(Boolean).join('\n\n');
    if (!message) { setStatus('error'); setError('Add a short report before sending.'); return; }
    setStatus('sending'); setError('');
    try {
      const res = await fetch('/api/feedback/report', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category, message, route: '/voice-settings', userAgent: navigator.userAgent }),
      });
      const data = await res.json().catch(() => ({ ok: res.ok }));
      if (res.ok && data?.ok !== false) {
        setStatus('sent'); setSummary(''); setDetails('');
        setTimeout(() => setStatus('idle'), 3000);
      } else {
        setStatus('error'); setError(typeof data?.error === 'string' ? data.error : 'Could not send — try again.');
      }
    } catch {
      setStatus('error'); setError('Could not reach the feedback service.');
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <h1 style={PAGE_TITLE_STYLE}>Report Issue</h1>
      <SectionCard>
        <SectionTitle icon={ICONS.warning}>Tell us what happened</SectionTitle>
        <SectionHint>Bug or request — it goes straight to the team with your app version + OS attached.</SectionHint>

        <div style={{ marginBottom: 14 }}>
          <Segmented value={category} onChange={setCategory} options={[{ value: 'bug', label: 'Bug' }, { value: 'request', label: 'Request' }]} />
        </div>

        <input
          value={summary} onChange={(e) => setSummary(e.target.value)}
          onFocus={() => setFS(true)} onBlur={() => setFS(false)}
          placeholder="One-line summary" style={{ ...INPUT_BASE, marginBottom: 10, ...focusStyle(fS) }}
        />
        <textarea
          value={details} onChange={(e) => setDetails(e.target.value)}
          onFocus={() => setFD(true)} onBlur={() => setFD(false)}
          placeholder="What happened? What did you expect?" rows={5}
          style={{ ...TEXTAREA_BASE, ...focusStyle(fD) }}
        />

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 14 }}>
          <AccentButton label={status === 'sending' ? 'Sending…' : 'Send report'} onClick={() => { if (status !== 'sending') void submit(); }} />
          {status === 'sent' ? <span style={{ fontSize: 12.5, color: OK_GREEN }}>Sent — thank you.</span> : null}
          {status === 'error' ? <span style={{ fontSize: 12.5, color: DANGER_RED }}>{error}</span> : null}
        </div>
      </SectionCard>
    </div>
  );
}
