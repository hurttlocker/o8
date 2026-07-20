'use client';

/**
 * ReportIssueHost — the GLOBAL "report an error" hotkey for the IDE dashboard.
 *
 * Cmd/Ctrl+Shift+E anywhere on the dashboard captures the o8 window and opens a
 * detailed report modal (note + screenshot) that posts one-way to the team
 * Discord via /api/feedback/report. Parity with the Settings > About form, but
 * reachable in one keystroke from anywhere so beta dogfooders can flag an error
 * without hunting through settings. The canvas has its own twin
 * (CanvasFeedbackButton) on the SAME hotkey; both share report-client.ts.
 *
 * Mounted once at the dashboard root (inside DictationHost). Always mounted so
 * the global keydown listener stays live; renders nothing until opened.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
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

type SendState = 'idle' | 'sending' | 'sent' | 'error';

export function ReportIssueHost() {
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<ReportCategory>('bug');
  const [message, setMessage] = useState('');
  const [image, setImage] = useState<ReportImage | null>(null);
  const [includeScreenshot, setIncludeScreenshot] = useState(true);
  const [screenshotExpanded, setScreenshotExpanded] = useState(false);
  const [state, setState] = useState<SendState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [reportId, setReportId] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
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
    setReportId(null);
  }, []);

  // Capture the window FIRST (modal still closed, so the shot is the app state,
  // not this modal), then open with it attached. Falls back to opening empty
  // when capture is unavailable (web) or denied — the user can paste/drop.
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

  // Global hotkey — Cmd/Ctrl+Shift+E, the SAME combo the canvas uses, so
  // "report from anywhere" is one muscle-memory keystroke across surfaces.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && (event.key === 'e' || event.key === 'E')) {
        event.preventDefault();
        void openWithCapture();
      } else if (event.key === 'Escape') {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openWithCapture]);

  // Also openable programmatically (a future menu item / status-bar button can
  // fire this) — keeps the entry point single even as affordances grow.
  useEffect(() => {
    const handler = () => { void openWithCapture(); };
    window.addEventListener('o8:open-report', handler);
    return () => window.removeEventListener('o8:open-report', handler);
  }, [openWithCapture]);

  useEffect(() => {
    if (open) textareaRef.current?.focus();
  }, [open]);

  const attach = useCallback(async (file: File | null | undefined) => {
    const result = await fileToReportImage(file);
    if (result.ok) {
      setImage(result.image);
      setIncludeScreenshot(true);
      setScreenshotExpanded(false);
      setState((previous) => (previous === 'sent' || previous === 'error' ? 'idle' : previous));
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
        if (file) { event.preventDefault(); void attach(file); return; }
      }
    }
  }, [attach]);

  const onDrop = useCallback((event: React.DragEvent) => {
    const file = event.dataTransfer?.files?.[0];
    if (file) { event.preventDefault(); void attach(file); }
  }, [attach]);

  const send = useCallback(async () => {
    const trimmed = message.trim();
    if (!trimmed) { setState('error'); setError('Add a short note first.'); return; }
    if (!await checkDataSharing(false)) return;
    setState('sending');
    setError(null);
    const route = typeof window !== 'undefined' ? `${window.location.pathname}${window.location.hash}` : 'dashboard';
    const result = await submitReport({
      category,
      message: trimmed,
      route,
      image: includeScreenshot ? image : null,
    });
    if (result.ok) {
      setState('sent');
      setReportId(result.reportId);
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

  if (!open || typeof document === 'undefined') return null;

  return createPortal((
    <div
      role="presentation"
      onClick={() => setOpen(false)}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 2147483600,
        background: 'rgba(0, 0, 0, 0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backdropFilter: 'blur(2px)',
        WebkitBackdropFilter: 'blur(2px)',
      } as React.CSSProperties}
    >
      <div
        role="dialog"
        aria-label="Report an issue"
        onClick={(event) => event.stopPropagation()}
        onPaste={onPaste}
        onDrop={onDrop}
        onDragOver={(event) => { if (event.dataTransfer?.types?.includes('Files')) event.preventDefault(); }}
        style={{
          width: 460,
          maxWidth: 'calc(100vw - 48px)',
          maxHeight: 'calc(100vh - 48px)',
          overflowY: 'auto',
          borderRadius: 14,
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: 'var(--t-panel-border)',
          background: 'var(--t-panel-solid)',
          boxShadow: '0 24px 64px rgba(0, 0, 0, 0.4)',
          padding: 20,
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          fontFamily: 'var(--font-sans-system)',
          color: 'var(--t-text)',
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 15, fontWeight: 500, letterSpacing: '-0.01em' }}>Report an issue</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 9.5, fontWeight: 300, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--t-text-muted)' }}>beta · private</span>
            <button
              type="button"
              aria-label="Close"
              onClick={() => setOpen(false)}
              style={{ width: 44, height: 44, borderWidth: 0, background: 'transparent', color: 'var(--t-text-muted)', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: 0 }}
            >
              ✕
            </button>
          </span>
        </div>

        {dataSharingStatus === 'checking' ? (
          <div style={{ paddingTop: 18, paddingBottom: 18, color: 'var(--t-text-muted)', fontSize: 13, lineHeight: 1.5 }}>
            Checking data-sharing settings…
          </div>
        ) : !dataSharingEnabled ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingTop: 12, paddingBottom: 8 }}>
            <div style={{ color: 'var(--t-text)', fontSize: 13, fontWeight: 300, lineHeight: 1.55 }}>
              {REPORT_DATA_SHARING_OFF_MESSAGE}
            </div>
            {dataSharingError ? (
              <div style={{ color: 'var(--t-danger, #ef4444)', fontSize: 12, fontWeight: 300, lineHeight: 1.45 }}>
                {dataSharingError}
              </div>
            ) : null}
            <button
              type="button"
              onClick={() => { void enableDataSharing(); }}
              disabled={dataSharingEnabling}
              style={{
                alignSelf: 'flex-start',
                minHeight: 34,
                paddingLeft: 16,
                paddingRight: 16,
                borderRadius: 9,
                borderWidth: 0,
                background: 'var(--t-accent)',
                color: '#ffffff',
                opacity: dataSharingEnabling ? 0.6 : 1,
                cursor: dataSharingEnabling ? 'default' : 'pointer',
                fontFamily: 'var(--font-sans-system)',
                fontSize: 12.5,
                fontWeight: 500,
              }}
            >
              {dataSharingEnabling ? 'Enabling…' : 'Enable sharing'}
            </button>
          </div>
        ) : (
          <>
        {/* bug / request */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, padding: 4, borderRadius: 10, background: 'var(--t-hover)' }}>
          {(['bug', 'request'] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={category === value}
              onClick={() => { setCategory(value); if (state === 'sent') setState('idle'); }}
              style={{
                minHeight: 44,
                borderRadius: 7,
                borderWidth: 0,
                background: category === value ? 'var(--t-accent-soft)' : 'transparent',
                color: category === value ? 'var(--t-accent)' : 'var(--t-text-muted)',
                cursor: 'pointer',
                fontFamily: 'var(--font-sans-system)',
                fontSize: 12,
                fontWeight: category === value ? 500 : 300,
                letterSpacing: '0.02em',
                textTransform: 'capitalize',
              }}
            >
              {value === 'bug' ? 'Bug' : 'Request'}
            </button>
          ))}
        </div>

        <textarea
          ref={textareaRef}
          value={message}
          maxLength={MAX_REPORT_MESSAGE}
          placeholder="What's off, or what would help? (⌘⇧E grabbed the window — paste or drop another shot if you want)"
          onChange={(event) => {
            setMessage(event.target.value);
            if (state === 'sent' || state === 'error') { setState('idle'); setError(null); }
          }}
          onPaste={onPaste}
          rows={5}
          style={{
            width: '100%',
            boxSizing: 'border-box',
            resize: 'none',
            padding: 12,
            borderRadius: 10,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'var(--t-input-border, var(--t-divider))',
            background: 'var(--t-input-bg)',
            color: 'var(--t-text)',
            outline: 'none',
            fontFamily: 'var(--font-sans-system)',
            fontSize: 13,
            fontWeight: 300,
            lineHeight: 1.5,
          }}
        />

        {/* Screenshot review — visible preview + explicit upload consent. */}
        {image ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 10, paddingRight: 10, paddingBottom: 10, paddingLeft: 10, borderRadius: 10, background: 'var(--t-input-bg)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <button
                type="button"
                aria-label="Expand screenshot preview"
                onClick={() => setScreenshotExpanded(true)}
                style={{ width: 132, height: 84, padding: 0, borderRadius: 8, borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--t-divider)', background: 'transparent', cursor: 'zoom-in', overflow: 'hidden', flexShrink: 0 }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={image.dataUrl} alt="Screenshot to review" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', opacity: includeScreenshot ? 1 : 0.48 }} />
              </button>
              <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
                <span style={{ width: '100%', fontSize: 12, fontWeight: 300, color: 'var(--t-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {image.name}
                </span>
                <span style={{ fontSize: 10.5, fontWeight: 300, color: 'var(--t-text-faint)' }}>Click preview to inspect full-size</span>
                <button
                  type="button"
                  onClick={() => { setImage(null); setScreenshotExpanded(false); setIncludeScreenshot(true); }}
                  style={{ minHeight: 44, borderWidth: 0, background: 'transparent', color: 'var(--t-text-muted)', cursor: 'pointer', fontFamily: 'var(--font-sans-system)', fontSize: 10.5, letterSpacing: '0.06em', textTransform: 'uppercase', paddingTop: 0, paddingRight: 4, paddingBottom: 0, paddingLeft: 4 }}
                >
                  Remove
                </button>
              </div>
            </div>
            <label style={{ minHeight: 44, display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: 12.5, fontWeight: 300, color: 'var(--t-text)' }}>
              <input
                type="checkbox"
                checked={includeScreenshot}
                onChange={(event) => setIncludeScreenshot(event.target.checked)}
                style={{ width: 18, height: 18, margin: 0, accentColor: 'var(--t-accent)', flexShrink: 0 }}
              />
              <span>Include screenshot with report</span>
            </label>
            <span style={{ fontSize: 11, fontWeight: 300, lineHeight: 1.4, color: 'var(--t-text-muted)' }}>
              Check for anything private — keys, tokens, personal info.
            </span>
          </div>
        ) : (
          <div style={{ padding: 10, borderRadius: 10, borderWidth: 1, borderStyle: 'dashed', borderColor: 'var(--t-divider)', background: 'transparent', textAlign: 'center', fontSize: 11.5, fontWeight: 300, color: 'var(--t-text-muted)' }}>
            No screenshot — paste or drop one to attach
          </div>
        )}

        {/* Footer */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <span style={{ fontSize: 12, fontWeight: 300, color: state === 'error' ? '#ef4444' : state === 'sent' ? 'var(--t-accent)' : 'var(--t-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {state === 'sent'
              // The id is their receipt — it's how the fix finds its way back to them.
              ? (reportId ? `Sent — report ${reportId}` : 'Sent — thanks')
              : state === 'error' ? (error ?? 'Send failed.') : `${message.length}/${MAX_REPORT_MESSAGE}`}
          </span>
          {state === 'sent' ? (
            <button
              type="button"
              onClick={reset}
              style={{ minHeight: 44, borderWidth: 0, background: 'transparent', color: 'var(--t-text-muted)', cursor: 'pointer', fontFamily: 'var(--font-sans-system)', fontSize: 12, fontWeight: 300, paddingTop: 0, paddingRight: 4, paddingBottom: 0, paddingLeft: 4 }}
            >
              Send another
            </button>
          ) : (
            <button
              type="button"
              onClick={() => { void send(); }}
              disabled={!canSend}
              style={{
                minHeight: 44,
                paddingLeft: 20,
                paddingRight: 20,
                borderRadius: 9,
                borderWidth: 0,
                background: 'var(--t-accent)',
                color: '#ffffff',
                opacity: canSend ? 1 : 0.4,
                cursor: canSend ? 'pointer' : 'default',
                fontFamily: 'var(--font-sans-system)',
                fontSize: 12.5,
                fontWeight: 500,
                letterSpacing: '0.02em',
                flexShrink: 0,
              }}
            >
              {state === 'sending' ? 'Sending…' : 'Send'}
            </button>
          )}
        </div>
          </>
        )}
      </div>
      {screenshotExpanded && image ? (
        <button
          type="button"
          aria-label="Close full-size screenshot preview"
          onClick={(event) => { event.stopPropagation(); setScreenshotExpanded(false); }}
          style={{ position: 'fixed', inset: 0, zIndex: 2147483601, width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', borderWidth: 0, background: 'var(--t-overlay-scrim)', cursor: 'zoom-out', paddingTop: 24, paddingRight: 24, paddingBottom: 24, paddingLeft: 24 }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={image.dataUrl}
            alt="Full-size screenshot review"
            style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: 10 }}
          />
        </button>
      ) : null}
    </div>
  ), document.body);
}
