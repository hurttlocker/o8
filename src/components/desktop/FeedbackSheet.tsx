'use client';

import { useEffect, useId, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { submitFeedback } from '@/lib/feedback/minimal-feedback-client';
import { useReportDataSharing } from '@/lib/feedback/report-data-sharing-client';
import { REPORT_DATA_SHARING_OFF_ERROR } from '@/lib/feedback/data-sharing';
import { RamsButton } from '@/components/desktop/settings/shared';

const fieldStyle: CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: 8, borderRadius: 8,
  borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--t-input-border)',
  background: 'var(--t-input-bg)', color: 'var(--t-text)',
  fontFamily: 'var(--font-sans-system)', fontSize: 13, fontWeight: 300,
};

/** Shared manual-feedback sheet; opening it never collects diagnostic context. */
export function FeedbackSheet({ onClose }: { onClose: () => void }) {
  const id = useId();
  const dialog = useRef<HTMLFormElement>(null);
  const messageInput = useRef<HTMLTextAreaElement>(null);
  const inFlight = useRef(false);
  const [message, setMessage] = useState('');
  const [email, setEmail] = useState('');
  const [includeMetadata, setIncludeMetadata] = useState(true);
  const [sending, setSending] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sharing = useReportDataSharing();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    messageInput.current?.focus();
    const containFocus = () => {
      if (!dialog.current?.contains(document.activeElement)) {
        dialog.current?.querySelector<HTMLElement>('textarea:not(:disabled), input:not(:disabled), button:not(:disabled)')?.focus();
      }
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeRef.current();
      } else if (event.key === 'Tab') {
        const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('textarea:not(:disabled), input:not(:disabled), button:not(:disabled)') ?? [])];
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener('keydown', keydown, true);
    document.addEventListener('focusin', containFocus);
    return () => {
      window.removeEventListener('keydown', keydown, true);
      document.removeEventListener('focusin', containFocus);
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  useEffect(() => {
    if (!sending) { setWaiting(false); return; }
    const timer = window.setTimeout(() => setWaiting(true), 3000);
    return () => window.clearTimeout(timer);
  }, [sending]);

  async function send(event: FormEvent) {
    event.preventDefault();
    if (inFlight.current || sent || !sharing.enabled || !message.trim()) return;
    inFlight.current = true;
    setSending(true);
    setError(null);
    try {
      const result = await submitFeedback({ message: message.trim(), email, includeMetadata });
      if (result.ok) setSent(true);
      else {
        if (result.code === REPORT_DATA_SHARING_OFF_ERROR) sharing.markDisabled();
        setError(result.error);
      }
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  }

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, zIndex: 2147483600, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--t-shell-backdrop)' }}>
      <form ref={dialog} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-privacy`} onSubmit={(event) => { void send(event); }}
        style={{ width: 440, maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100vh - 32px)', overflowY: 'auto', scrollbarWidth: 'none', padding: 24, borderRadius: 16, background: 'var(--t-popover-surface)', borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--t-panel-border)', color: 'var(--t-text)', fontFamily: 'var(--font-sans-system)', fontSize: 13, fontWeight: 300, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <h2 id={`${id}-title`} style={{ margin: 0, fontSize: 18, fontWeight: 400 }}>Send feedback</h2>
        <label htmlFor={`${id}-message`}>What almost made you quit, or what should be better?</label>
        <textarea ref={messageInput} id={`${id}-message`} value={message} onChange={(event) => setMessage(event.target.value)} maxLength={4000} rows={4} required disabled={sending || sent} style={{ ...fieldStyle, resize: 'none', lineHeight: 1.5 }} />
        <label htmlFor={`${id}-email`}>Email (optional)</label>
        <input id={`${id}-email`} type="email" maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} disabled={sending || sent} style={fieldStyle} />
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 44 }}>
          <input type="checkbox" checked={includeMetadata} onChange={(event) => setIncludeMetadata(event.target.checked)} disabled={sending || sent} />
          Include app version and OS
        </label>
        <p id={`${id}-privacy`} style={{ margin: 0, color: 'var(--t-text-muted)', lineHeight: 1.5 }}>Anonymous unless you enter an email. Only your text and selected details are sent. No repository content, file paths, prompts, or screenshots are attached.</p>
        {sharing.status === 'checking' ? <p role="status" style={{ margin: 0 }}>Checking sharing settings…</p> : !sharing.enabled ? <p role="status" style={{ margin: 0 }}>Feedback is disabled while crash &amp; error reports are off. Enable sharing in Settings to send feedback.</p> : null}
        {sharing.error || error ? <p role="alert" style={{ margin: 0, color: 'var(--t-brand-red)' }}>{error || sharing.error}</p> : null}
        {sent ? <p role="status" style={{ margin: 0 }}>Feedback sent. Thank you.</p> : null}
        {waiting ? <p role="status" style={{ margin: 0 }}>Waiting for the feedback service to confirm receipt…</p> : null}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <RamsButton variant="ghost" onClick={onClose}>{sent ? 'Done' : 'Cancel'}</RamsButton>
          <RamsButton type="submit" busy={sending} disabled={!sharing.enabled || !message.trim() || sent}>{sending ? 'Sending feedback…' : 'Send feedback'}</RamsButton>
        </div>
      </form>
    </div>, document.body,
  );
}

export function FeedbackSettingsEntry() {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginTop: 'auto', padding: 8 }}>
      <RamsButton variant="ghost" onClick={() => setOpen(true)}>Send Feedback…</RamsButton>
      {open ? <FeedbackSheet onClose={() => setOpen(false)} /> : null}
    </div>
  );
}
