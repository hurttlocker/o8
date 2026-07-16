'use client';

/**
 * Report Issue tab — bug/request form that POSTs to o8's shared feedback endpoint
 * (`/api/feedback/report` → o8's Discord webhook, the same path the main app's
 * Report Issue uses). Supports up to 5 screenshots (attach or paste ⌘V).
 */
import { useRef, useState, type CSSProperties } from 'react';
import {
  ACCENT, ACCENT_GLOW, DANGER_RED, GLASS_BG, GLASS_BG_HOVER, GLASS_BORDER_SUBTLE, OK_GREEN, SF,
  TEXT_PRIMARY, TEXT_SECONDARY, TEXT_TERTIARY, TRANS_FAST, ICONS,
} from '../tokens';
import { SectionCard, SectionTitle, SectionHint, Segmented, AccentButton, Icon, PageHeader } from '../primitives';
import { REPORT_DATA_SHARING_OFF_ERROR, REPORT_DATA_SHARING_OFF_MESSAGE } from '@/lib/feedback/data-sharing';
import { useReportDataSharing } from '@/lib/feedback/report-data-sharing-client';

const MAX_IMAGES = 5;

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
interface Shot { id: string; dataUrl: string; name: string }

export default function ReportTab() {
  const [category, setCategory] = useState('bug');
  const [summary, setSummary] = useState('');
  const [details, setDetails] = useState('');
  const [shots, setShots] = useState<Shot[]>([]);
  const [fS, setFS] = useState(false);
  const [fD, setFD] = useState(false);
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const idRef = useRef(0);
  const {
    status: dataSharingStatus,
    error: dataSharingError,
    enabling: dataSharingEnabling,
    enabled: dataSharingEnabled,
    check: checkDataSharing,
    enable: enableDataSharing,
    markDisabled: markDataSharingDisabled,
  } = useReportDataSharing();

  const attach = (files: FileList | File[] | null) => {
    if (!files) return;
    for (const file of Array.from(files)) {
      if (!file.type.startsWith('image/')) continue;
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result || '');
        if (!dataUrl) return;
        setShots((prev) => prev.length >= MAX_IMAGES ? prev : [...prev, { id: `s${idRef.current++}`, dataUrl, name: file.name || 'screenshot.png' }]);
      };
      reader.readAsDataURL(file);
    }
  };
  const remove = (id: string) => setShots((p) => p.filter((s) => s.id !== id));

  const onPaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) { const f = item.getAsFile(); if (f) files.push(f); }
    }
    if (files.length) { e.preventDefault(); attach(files); }
  };

  const submit = async () => {
    const message = [summary.trim(), details.trim()].filter(Boolean).join('\n\n');
    if (!message) { setStatus('error'); setError('Add a short report before sending.'); return; }
    if (!await checkDataSharing(false)) return;
    setStatus('sending'); setError('');
    try {
      const res = await fetch('/api/feedback/report', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category, message, route: '/voice-settings', userAgent: navigator.userAgent,
          images: shots.map((s) => ({ dataUrl: s.dataUrl, name: s.name })),
        }),
      });
      const data = await res.json().catch(() => ({ ok: res.ok })) as { ok?: boolean; error?: string; message?: string };
      if (res.ok && data?.ok !== false) {
        setStatus('sent'); setSummary(''); setDetails(''); setShots([]);
        setTimeout(() => setStatus('idle'), 3000);
      } else {
        if (data?.error === REPORT_DATA_SHARING_OFF_ERROR) markDataSharingDisabled();
        setStatus('error');
        setError(data?.message || data?.error || 'Could not send — try again.');
      }
    } catch {
      setStatus('error'); setError('Could not reach the feedback service.');
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <PageHeader icon={ICONS.warning} title="Report Issue" />
      <SectionCard>
        <SectionTitle icon={ICONS.warning}>Tell us what happened</SectionTitle>
        {dataSharingStatus === 'checking' ? (
          <div style={{ paddingTop: 10, paddingBottom: 10, color: TEXT_TERTIARY, fontSize: 12.5, fontFamily: SF, lineHeight: 1.55 }}>
            Checking data-sharing settings…
          </div>
        ) : !dataSharingEnabled ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 10, paddingTop: 10 }}>
            <div style={{ color: TEXT_PRIMARY, fontSize: 12.5, fontFamily: SF, lineHeight: 1.55 }}>
              {REPORT_DATA_SHARING_OFF_MESSAGE}
            </div>
            {dataSharingError ? (
              <div style={{ color: DANGER_RED, fontSize: 11.5, fontFamily: SF, lineHeight: 1.45 }}>
                {dataSharingError}
              </div>
            ) : null}
            <AccentButton
              label={dataSharingEnabling ? 'Enabling…' : 'Enable sharing'}
              onClick={() => { if (!dataSharingEnabling) void enableDataSharing(); }}
            />
          </div>
        ) : (
          <>
        <SectionHint>Voice glitch or any o8 bug — it goes straight to the o8 team in Discord with your app version + OS attached.</SectionHint>

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
          onPaste={onPaste}
          onFocus={() => setFD(true)} onBlur={() => setFD(false)}
          placeholder="What happened? What did you expect?  (paste screenshots here with ⌘V)" rows={5}
          style={{ ...TEXTAREA_BASE, ...focusStyle(fD) }}
        />

        {/* Attachments */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
          {shots.map((s) => <Thumb key={s.id} shot={s} onRemove={() => remove(s.id)} />)}
          {shots.length < MAX_IMAGES ? (
            <button
              type="button" onClick={() => fileRef.current?.click()} aria-label="Attach screenshot"
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, height: 52, paddingLeft: 14, paddingRight: 14,
                borderRadius: 12, border: `1px dashed ${GLASS_BORDER_SUBTLE}`, background: GLASS_BG,
                color: TEXT_SECONDARY, fontSize: 12, fontFamily: SF, cursor: 'pointer',
              }}
            >
              <Icon icon={ICONS.copy} size={14} /> Attach
            </button>
          ) : null}
          <input
            ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple
            style={{ display: 'none' }} onChange={(e) => { attach(e.target.files); e.target.value = ''; }}
          />
        </div>
        <div style={{ fontSize: 11, color: TEXT_TERTIARY, marginTop: 6 }}>Up to {MAX_IMAGES} screenshots · 8 MB total</div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16 }}>
          <AccentButton label={status === 'sending' ? 'Sending…' : 'Send report'} onClick={() => { if (status !== 'sending') void submit(); }} />
          {status === 'sent' ? <span style={{ fontSize: 12.5, color: OK_GREEN }}>Sent — thank you.</span> : null}
          {status === 'error' ? <span style={{ fontSize: 12.5, color: DANGER_RED }}>{error}</span> : null}
        </div>
          </>
        )}
      </SectionCard>
    </div>
  );
}

function Thumb({ shot, onRemove }: { shot: Shot; onRemove: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ position: 'relative', width: 52, height: 52, borderRadius: 12, overflow: 'hidden', border: `1px solid ${GLASS_BORDER_SUBTLE}`, flexShrink: 0 }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={shot.dataUrl} alt={shot.name} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
      <button
        type="button" aria-label="Remove" onClick={onRemove}
        style={{
          position: 'absolute', top: 2, right: 2, width: 18, height: 18, borderRadius: '50%', border: 'none',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 0, cursor: 'pointer',
          background: 'rgba(0,0,0,0.6)', color: 'white', opacity: hover ? 1 : 0.7,
        }}
      >
        <Icon icon={ICONS.close} size={11} color="white" />
      </button>
    </div>
  );
}
