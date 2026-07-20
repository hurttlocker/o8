'use client';

/**
 * CanvasFeedbackButton — a tiny, unobtrusive feedback affordance for the canvas
 * (operator ask, 2026-06-16; o8.md note line 15). Lives in the top-right chrome
 * pill beside search/account. Two ways in:
 *   • Click the speech-bubble → instant popover (type a note, optional paste).
 *   • Cmd/Ctrl+Shift+E → auto-captures the o8 window (Rust capture_app_window,
 *     screencapture region), THEN opens the popover with the shot attached —
 *     the frictionless "screenshot this error" path from the note. Captured
 *     before the modal opens, so the shot shows the app state, not the modal.
 * Both → the existing one-way Discord intake at /api/feedback/report (route
 * "canvas"), and the operator can remove the shot before sending.
 *
 * Follow-up (not yet): make it app-wide (dashboard too) + the optional ~5s clip.
 */

import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  captureAppWindow,
  fileToReportImage,
  submitReport,
  MAX_REPORT_MESSAGE,
  type ReportCategory,
  type ReportImage,
} from '@/lib/feedback/report-client';
import { REPORT_DATA_SHARING_OFF_ERROR, REPORT_DATA_SHARING_OFF_MESSAGE } from '@/lib/feedback/data-sharing';
import { useReportDataSharing } from '@/lib/feedback/report-data-sharing-client';
import { FONT, glass } from './ui';

type SendState = 'idle' | 'sending' | 'sent' | 'error';

const ACCENT = '#f59e0b'; // the canvas one-orange, used sparingly

export function CanvasFeedbackButton() {
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<ReportCategory>('bug');
  const [message, setMessage] = useState('');
  const [image, setImage] = useState<ReportImage | null>(null);
  const [includeScreenshot, setIncludeScreenshot] = useState(true);
  const [screenshotExpanded, setScreenshotExpanded] = useState(false);
  const [state, setState] = useState<SendState>('idle');
  const [error, setError] = useState<string | null>(null);
  const {
    status: dataSharingStatus,
    error: dataSharingError,
    enabling: dataSharingEnabling,
    enabled: dataSharingEnabled,
    check: checkDataSharing,
    enable: enableDataSharing,
    markDisabled: markDataSharingDisabled,
  } = useReportDataSharing();

  const reset = useCallback(() => {
    setMessage('');
    setImage(null);
    setIncludeScreenshot(true);
    setScreenshotExpanded(false);
    setState('idle');
    setError(null);
  }, []);

  // The Cmd/Ctrl+Shift+E path: capture the o8 window FIRST (modal still closed,
  // so the shot is the app state, not this popover), then open with it attached.
  // Falls back to opening empty if capture is unavailable (web) or denied.
  const openWithCapture = useCallback(async () => {
    setState('idle');
    setError(null);
    setIncludeScreenshot(true);
    setScreenshotExpanded(false);
    const enabled = await checkDataSharing();
    if (!enabled) {
      setImage(null);
      setOpen(true);
      return;
    }
    const shot = await captureAppWindow();
    setImage(shot);
    setOpen(true);
  }, [checkDataSharing]);

  const openWithoutCapture = useCallback(async () => {
    setImage(null);
    setIncludeScreenshot(true);
    setScreenshotExpanded(false);
    setOpen(true);
    await checkDataSharing();
  }, [checkDataSharing]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && (event.key === 'e' || event.key === 'E')) {
        event.preventDefault();
        void openWithCapture();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openWithCapture]);

  const attachImage = useCallback(async (file: File | null | undefined) => {
    const result = await fileToReportImage(file);
    if (result.ok) {
      setImage(result.image);
      setIncludeScreenshot(true);
      setScreenshotExpanded(false);
      setState((p) => (p === 'sent' || p === 'error' ? 'idle' : p));
      setError(null);
    } else {
      setState('error');
      setError(result.error);
    }
  }, []);

  const onPaste = useCallback((event: React.ClipboardEvent) => {
    const items = event.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i += 1) {
      if (items[i].type.startsWith('image/')) {
        const file = items[i].getAsFile();
        if (file) { event.preventDefault(); void attachImage(file); return; }
      }
    }
  }, [attachImage]);

  const onDrop = useCallback((event: React.DragEvent) => {
    const file = event.dataTransfer?.files?.[0];
    if (file) { event.preventDefault(); void attachImage(file); }
  }, [attachImage]);

  const send = useCallback(async () => {
    const trimmed = message.trim();
    if (!trimmed) { setState('error'); setError('Add a short note first.'); return; }
    if (!await checkDataSharing(false)) return;
    setState('sending');
    setError(null);
    const result = await submitReport({
      category,
      message: trimmed,
      route: 'canvas',
      image: includeScreenshot ? image : null,
    });
    if (result.ok) {
      setState('sent');
      setMessage('');
      setImage(null);
      setIncludeScreenshot(true);
      setScreenshotExpanded(false);
    } else {
      if (result.code === REPORT_DATA_SHARING_OFF_ERROR) markDataSharingDisabled();
      setState('error');
      setError(result.error);
    }
  }, [category, checkDataSharing, image, includeScreenshot, markDataSharingDisabled, message]);

  const canSend = dataSharingEnabled && message.trim().length > 0 && state !== 'sending';

  return (
    <>
      {/* Trigger — sits in the top-right chrome pill, same 28px target as search. */}
      <button
        type="button"
        aria-label="Send feedback"
        title="Send feedback"
        onClick={() => {
          if (open) setOpen(false);
          else void openWithoutCapture();
        }}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 28,
          height: 28,
          borderWidth: 0,
          background: 'transparent',
          borderRadius: 14,
          color: open ? 'var(--cnv-ink)' : 'var(--cnv-ink-muted)',
          cursor: 'pointer',
        }}
        onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--cnv-ink)'; }}
        onMouseLeave={(event) => { if (!open) event.currentTarget.style.color = 'var(--cnv-ink-muted)'; }}
      >
        {/* speech bubble — width/height inline (attr sizing collapses in flex) */}
        <svg style={{ width: 13, height: 13, flexShrink: 0 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      </button>

      {open && typeof document !== 'undefined' ? createPortal((
        <>
          <div role="presentation" onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 45 }} />
          <div
            onPaste={onPaste}
            onDrop={onDrop}
            onDragOver={(event) => { if (event.dataTransfer?.types?.includes('Files')) event.preventDefault(); }}
            style={{
              position: 'fixed',
              top: 66,
              right: 24,
              width: 288,
              zIndex: 46,
              borderRadius: 16,
              padding: 14,
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              fontFamily: FONT,
              color: 'var(--cnv-ink)',
              ...glass(true),
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 12.5, fontWeight: 500, letterSpacing: '-0.01em' }}>Send feedback</span>
              <span style={{ fontSize: 9, fontWeight: 300, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--cnv-ink-muted)' }}>beta · one-way</span>
            </div>

            {dataSharingStatus === 'checking' ? (
              <div style={{ paddingTop: 14, paddingBottom: 14, color: 'var(--cnv-ink-muted)', fontSize: 11.5, fontWeight: 300, lineHeight: 1.5 }}>
                Checking data-sharing settings…
              </div>
            ) : !dataSharingEnabled ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 8, paddingBottom: 4 }}>
                <div style={{ color: 'var(--cnv-ink)', fontSize: 11.5, fontWeight: 300, lineHeight: 1.55 }}>
                  {REPORT_DATA_SHARING_OFF_MESSAGE}
                </div>
                {dataSharingError ? (
                  <div style={{ color: '#ef4444', fontSize: 10.5, fontWeight: 300, lineHeight: 1.45 }}>
                    {dataSharingError}
                  </div>
                ) : null}
                <button
                  type="button"
                  onClick={() => { void enableDataSharing(); }}
                  disabled={dataSharingEnabling}
                  style={{
                    alignSelf: 'flex-start',
                    minHeight: 30,
                    paddingLeft: 14,
                    paddingRight: 14,
                    borderRadius: 8,
                    borderWidth: 0,
                    background: ACCENT,
                    color: '#1a1206',
                    opacity: dataSharingEnabling ? 0.6 : 1,
                    cursor: dataSharingEnabling ? 'default' : 'pointer',
                    fontFamily: FONT,
                    fontSize: 11.5,
                    fontWeight: 500,
                  }}
                >
                  {dataSharingEnabling ? 'Enabling…' : 'Enable sharing'}
                </button>
              </div>
            ) : (
              <>
            {/* bug / request */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 3, padding: 3, borderRadius: 9, background: 'var(--cnv-tint)' }}>
              {(['bug', 'request'] as const).map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-pressed={category === c}
                  onClick={() => { setCategory(c); if (state === 'sent') setState('idle'); }}
                  style={{
                    minHeight: 28,
                    borderRadius: 7,
                    borderWidth: 0,
                    background: category === c ? 'var(--cnv-tint-deep)' : 'transparent',
                    color: category === c ? 'var(--cnv-ink)' : 'var(--cnv-ink-muted)',
                    cursor: 'pointer',
                    fontFamily: FONT,
                    fontSize: 11,
                    fontWeight: category === c ? 400 : 300,
                    letterSpacing: '0.02em',
                    textTransform: 'capitalize',
                  }}
                >
                  {c}
                </button>
              ))}
            </div>

            <textarea
              value={message}
              maxLength={MAX_REPORT_MESSAGE}
              placeholder="What's off, or what would help? (⌘⇧E captures the window; or paste a shot)"
              autoFocus
              onChange={(event) => {
                setMessage(event.target.value);
                if (state === 'sent' || state === 'error') { setState('idle'); setError(null); }
              }}
              onPaste={onPaste}
              rows={4}
              style={{
                width: '100%',
                boxSizing: 'border-box',
                resize: 'none',
                padding: 10,
                borderRadius: 10,
                borderWidth: 1,
                borderStyle: 'solid',
                borderColor: 'var(--cnv-edge)',
                background: 'var(--cnv-tint)',
                color: 'var(--cnv-ink)',
                outline: 'none',
                fontFamily: FONT,
                fontSize: 12.5,
                fontWeight: 300,
                lineHeight: 1.45,
              }}
            />

            {image ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7, paddingTop: 7, paddingRight: 7, paddingBottom: 7, paddingLeft: 7, borderRadius: 9, background: 'var(--cnv-tint)' }}>
                <button
                  type="button"
                  aria-label="Expand screenshot preview"
                  onClick={() => setScreenshotExpanded(true)}
                  style={{ width: '100%', height: 118, padding: 0, borderRadius: 7, borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--cnv-edge)', background: 'transparent', cursor: 'zoom-in', overflow: 'hidden' }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={image.dataUrl} alt="Screenshot to review" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', opacity: includeScreenshot ? 1 : 0.48 }} />
                </button>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 11, fontWeight: 300, color: 'var(--cnv-ink-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {image.name}
                  </span>
                  <button
                    type="button"
                    onClick={() => { setImage(null); setScreenshotExpanded(false); setIncludeScreenshot(true); }}
                    style={{ minHeight: 44, borderWidth: 0, background: 'transparent', color: 'var(--cnv-ink-muted)', cursor: 'pointer', fontFamily: FONT, fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', paddingTop: 0, paddingRight: 4, paddingBottom: 0, paddingLeft: 4, flexShrink: 0 }}
                  >
                    Remove
                  </button>
                </div>
                <label style={{ minHeight: 44, display: 'flex', alignItems: 'center', gap: 9, cursor: 'pointer', fontSize: 11.5, fontWeight: 300, color: 'var(--cnv-ink)' }}>
                  <input
                    type="checkbox"
                    checked={includeScreenshot}
                    onChange={(event) => setIncludeScreenshot(event.target.checked)}
                    style={{ width: 18, height: 18, margin: 0, accentColor: ACCENT, flexShrink: 0 }}
                  />
                  <span>Include screenshot with report</span>
                </label>
                <span style={{ fontSize: 10.5, fontWeight: 300, lineHeight: 1.4, color: 'var(--cnv-ink-muted)' }}>
                  Check for anything private — keys, tokens, personal info.
                </span>
              </div>
            ) : null}

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
              <span style={{ fontSize: 11, fontWeight: 300, color: state === 'error' ? '#ef4444' : state === 'sent' ? ACCENT : 'var(--cnv-ink-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {state === 'sent' ? 'Sent — thanks' : state === 'error' ? (error ?? 'Send failed.') : `${message.length}/${MAX_REPORT_MESSAGE}`}
              </span>
              <button
                type="button"
                onClick={() => { void send(); }}
                disabled={!canSend}
                style={{
                  minHeight: 44,
                  paddingLeft: 16,
                  paddingRight: 16,
                  borderRadius: 8,
                  borderWidth: 0,
                  background: canSend ? ACCENT : 'var(--cnv-tint-deep)',
                  color: canSend ? '#1a1206' : 'var(--cnv-ink-muted)',
                  cursor: canSend ? 'pointer' : 'default',
                  fontFamily: FONT,
                  fontSize: 11.5,
                  fontWeight: 500,
                  letterSpacing: '0.02em',
                  flexShrink: 0,
                }}
              >
                {state === 'sending' ? 'Sending' : state === 'sent' ? 'Sent' : 'Send'}
              </button>
            </div>

            {state === 'sent' ? (
              <button
                type="button"
                onClick={reset}
                style={{ alignSelf: 'flex-start', borderWidth: 0, background: 'transparent', color: 'var(--cnv-ink-muted)', cursor: 'pointer', fontFamily: FONT, fontSize: 10.5, fontWeight: 300, padding: 0 }}
              >
                Send another
              </button>
            ) : null}
              </>
            )}
          </div>
          {screenshotExpanded && image ? (
            <button
              type="button"
              aria-label="Close full-size screenshot preview"
              onClick={() => setScreenshotExpanded(false)}
              style={{ position: 'fixed', inset: 0, zIndex: 47, width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', borderWidth: 0, background: 'var(--t-overlay-scrim)', cursor: 'zoom-out', paddingTop: 24, paddingRight: 24, paddingBottom: 24, paddingLeft: 24 }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={image.dataUrl}
                alt="Full-size screenshot review"
                style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: 10 }}
              />
            </button>
          ) : null}
        </>
      ), document.body) : null}
    </>
  );
}
