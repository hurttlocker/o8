'use client';

/**
 * PacketActionStrip — four hairline pill actions rendered inside an expanded
 * packet card: retry, reset, open (GitHub issue), copy (packet prompt).
 *
 * Parent owns the packet identity and the derived issueUrl / prompt. Retry
 * and reset fire against the existing reset-packet endpoint via helpers in
 * packet-actions.ts. The strip renders its own 2s inline toast below the
 * pills — no portal, no global toast bus.
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { callResetPacket, callRetryPacket } from '@/lib/orchestrator/packet-actions';
import { getRuntimeCapability } from '@/lib/orchestrator/runtime-capabilities';
import type { OrchestratorRuntime } from '@/lib/orchestrator/types';
import { openExternalUrl } from '@/lib/desktop/open-external';

type ToastTone = 'retry' | 'neutral' | 'error';

interface PacketActionStripProps {
  packetId: string;
  issueUrl: string | null;
  prompt: string | null;
  runtime?: OrchestratorRuntime;
}

function RetryIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M21 12a9 9 0 0 1-9 9" />
      <path d="M3 12a9 9 0 0 1 9-9" />
      <path d="M21 3v6h-6" />
      <path d="M3 21v-6h6" />
    </svg>
  );
}

function ResetIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <circle cx="12" cy="12" r="10" />
      <path d="m15 9-6 6" />
      <path d="m9 9 6 6" />
    </svg>
  );
}

function OpenIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </svg>
  );
}

function CopyIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function ActionPill({
  onClick,
  disabled,
  title,
  children,
}: {
  onClick: () => void;
  disabled: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 24,
        paddingTop: 0,
        paddingBottom: 0,
        paddingLeft: 8,
        paddingRight: 10,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'var(--t-border-subtle)',
        borderRadius: 8,
        background: 'var(--t-bg-card)',
        color: 'var(--t-text-secondary)',
        fontSize: 11,
        fontWeight: 500,
        fontFamily: "'iA Writer Mono', 'JetBrains Mono', 'SF Mono', Menlo, ui-monospace, monospace",
        letterSpacing: '-0.005em',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        transition: 'background 120ms cubic-bezier(0.22, 1, 0.36, 1), color 120ms cubic-bezier(0.22, 1, 0.36, 1), border-color 120ms cubic-bezier(0.22, 1, 0.36, 1)',
      }}
      onMouseEnter={(event) => {
        if (disabled) return;
        event.currentTarget.style.background = 'var(--t-panel-hover)';
        event.currentTarget.style.color = 'var(--t-text)';
        event.currentTarget.style.borderColor = 'var(--t-border)';
      }}
      onMouseLeave={(event) => {
        event.currentTarget.style.background = 'var(--t-bg-card)';
        event.currentTarget.style.color = 'var(--t-text-secondary)';
        event.currentTarget.style.borderColor = 'var(--t-border-subtle)';
      }}
    >
      {children}
    </button>
  );
}

function PacketActionStripBase({ packetId, issueUrl, prompt, runtime }: PacketActionStripProps) {
  const runtimeLabel = runtime ? getRuntimeCapability(runtime).label : 'agent';
  const [busy, setBusy] = useState<'retry' | 'reset' | null>(null);
  const [toast, setToast] = useState<{ message: string; tone: ToastTone } | null>(null);
  const toastTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current !== null) {
        window.clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  const showToast = useCallback((message: string, tone: ToastTone) => {
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
    }
    setToast({ message, tone });
    toastTimerRef.current = window.setTimeout(() => {
      setToast(null);
      toastTimerRef.current = null;
    }, 2000);
  }, []);

  const handleRetry = useCallback(async () => {
    if (busy) return;
    setBusy('retry');
    const result = await callRetryPacket(packetId);
    if (!result.unsettled) setBusy(null);
    if (result.ok) {
      showToast(
        result.note ?? `Packet retried · waiting for ${runtimeLabel}`,
        result.salvaged ? 'neutral' : 'retry',
      );
    } else {
      showToast(result.note ?? 'Retry failed', 'error');
    }
  }, [busy, packetId, showToast, runtimeLabel]);

  const handleReset = useCallback(async () => {
    if (busy) return;
    setBusy('reset');
    const result = await callResetPacket(packetId);
    if (!result.unsettled) setBusy(null);
    if (result.ok) {
      showToast('Packet reset · lane archived', 'neutral');
    } else {
      showToast(result.note ?? 'Reset failed', 'error');
    }
  }, [busy, packetId, showToast]);

  const handleOpen = useCallback(() => {
    if (!issueUrl) return;
    openExternalUrl(issueUrl);
  }, [issueUrl]);

  const handleCopy = useCallback(async () => {
    if (!prompt) return;
    if (!navigator.clipboard?.writeText) {
      showToast('Clipboard unavailable', 'error');
      return;
    }
    try {
      await navigator.clipboard.writeText(prompt);
      showToast('Prompt copied to clipboard', 'neutral');
    } catch {
      showToast('Copy failed', 'error');
    }
  }, [prompt, showToast]);

  const toastBg = toast?.tone === 'retry'
    ? 'rgba(255, 90, 31, 0.08)'
    : toast?.tone === 'error'
      ? 'rgba(239, 68, 68, 0.08)'
      : 'var(--t-bg-card)';
  const toastBorder = toast?.tone === 'retry'
    ? 'rgba(255, 90, 31, 0.32)'
    : toast?.tone === 'error'
      ? 'rgba(239, 68, 68, 0.32)'
      : 'var(--t-border-subtle)';
  const toastColor = toast?.tone === 'error' ? 'var(--t-danger, #ef4444)' : 'var(--t-text-secondary)';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        <ActionPill onClick={handleRetry} disabled={busy !== null} title="Re-dispatch this packet">
          <RetryIcon size={13} />
          <span>retry</span>
        </ActionPill>
        <ActionPill onClick={handleReset} disabled={busy !== null} title="Reset packet · archive lane · clear worktree">
          <ResetIcon size={13} />
          <span>reset</span>
        </ActionPill>
        <ActionPill onClick={handleOpen} disabled={!issueUrl} title={issueUrl ? 'Open GitHub issue' : 'No issue URL available'}>
          <OpenIcon size={13} />
          <span>open</span>
        </ActionPill>
        <ActionPill onClick={() => { void handleCopy(); }} disabled={!prompt} title={prompt ? 'Copy packet prompt to clipboard' : 'No prompt available'}>
          <CopyIcon size={13} />
          <span>copy</span>
        </ActionPill>
      </div>
      {toast ? (
        <div
          style={{
            paddingTop: 4,
            paddingBottom: 4,
            paddingLeft: 8,
            paddingRight: 8,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: toastBorder,
            borderRadius: 6,
            background: toastBg,
            color: toastColor,
            fontSize: 10.5,
            fontFamily: "'iA Writer Mono', 'JetBrains Mono', 'SF Mono', Menlo, ui-monospace, monospace",
            letterSpacing: '-0.005em',
          }}
        >
          {toast.message}
        </div>
      ) : null}
    </div>
  );
}

export const PacketActionStrip = memo(PacketActionStripBase);
