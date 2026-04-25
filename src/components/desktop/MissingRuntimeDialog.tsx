'use client';

/**
 * MissingRuntimeDialog — modal shown when the operator clicks "Dispatch"
 * (or otherwise tries to launch a packet) on a runtime that isn't on PATH.
 *
 * Was filed as part of issue #633 — first-run validation. Before this
 * existed, an operator with zero CLIs installed would see their packet
 * silently fail with a cryptic `spawn codex ENOENT` message tucked inside
 * the packet card's `blockedReason`. The modal renders the install
 * command + a deep link back to onboarding so the recovery path is
 * obvious.
 */

import { memo } from 'react';
import { getRuntimeInstallInfo } from '@/lib/setup/runtime-install';

const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Display", system-ui, sans-serif';
const MONO = '"SF Mono", ui-monospace, monospace';

export interface MissingRuntimeContext {
  runtimeId: string;
  /** Friendly capability label (e.g. "Codex"). Falls back to runtimeId. */
  runtimeLabel?: string;
  /** Optional packet reference label so the user knows which task is blocked. */
  packetLabel?: string;
}

function MissingRuntimeDialogBase({
  context,
  onClose,
  onOpenSetup,
}: {
  context: MissingRuntimeContext;
  onClose: () => void;
  onOpenSetup: () => void;
}) {
  const info = getRuntimeInstallInfo(context.runtimeId);
  const label = info?.label ?? context.runtimeLabel ?? context.runtimeId;

  return (
    <div
      data-testid="missing-runtime-dialog"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 99999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(8, 12, 18, 0.62)',
        backdropFilter: 'blur(18px) saturate(1.04)',
        WebkitBackdropFilter: 'blur(18px) saturate(1.04)',
      } as React.CSSProperties}
      onClick={onClose}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: 460,
          margin: '0 20px',
          padding: '24px 24px 20px',
          borderRadius: 18,
          background: 'var(--t-bg-card)',
          border: '1px solid var(--t-divider-strong)',
          boxShadow: '0 24px 64px rgba(0, 0, 0, 0.32)',
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          fontFamily: FONT,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <span
            aria-hidden="true"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 36,
              height: 36,
              borderRadius: 10,
              background: 'rgba(245, 158, 11, 0.14)',
              color: '#b45309',
              flexShrink: 0,
            }}
          >
            <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
              <path d="M12 9v4" />
              <path d="M12 17h.01" />
            </svg>
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--t-text-strong)', letterSpacing: '-0.01em' }}>
              {label} isn&apos;t installed
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--t-text-secondary)', marginTop: 4, lineHeight: 1.5 }}>
              {context.packetLabel
                ? `${context.packetLabel} can't dispatch — `
                : 'This packet can\'t dispatch — '}
              o8 couldn&apos;t find the {label} CLI on your PATH.
            </div>
          </div>
        </div>

        {info?.command ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--t-text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Install
            </span>
            <code
              style={{
                display: 'block',
                padding: '10px 12px',
                borderRadius: 10,
                background: 'var(--t-glass-muted)',
                border: '1px solid var(--t-glass-border-strong)',
                fontFamily: MONO,
                fontSize: 12.5,
                color: 'var(--t-text)',
                userSelect: 'all',
              }}
            >
              {info.command}
            </code>
          </div>
        ) : null}

        {info?.link ? (
          <a
            href={info.link}
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontSize: 12, fontWeight: 600, color: 'var(--t-accent)', textDecoration: 'none' }}
          >
            {info.link.replace(/^https?:\/\//, '')} →
          </a>
        ) : null}

        <div style={{ fontSize: 11.5, color: 'var(--t-text-muted)', lineHeight: 1.5 }}>
          After installing, restart o8 (or the embedded shell) so it can pick up the new binary.
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
          <button
            type="button"
            onClick={onClose}
            style={{
              border: 'none',
              background: 'transparent',
              color: 'var(--t-text-muted)',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              padding: '8px 12px',
              borderRadius: 8,
            }}
          >
            Close
          </button>
          <button
            type="button"
            onClick={onOpenSetup}
            style={{
              border: 'none',
              background: 'var(--t-accent)',
              color: '#fff',
              fontSize: 12,
              fontWeight: 700,
              cursor: 'pointer',
              padding: '8px 14px',
              borderRadius: 8,
              letterSpacing: '-0.01em',
            }}
          >
            Open setup
          </button>
        </div>
      </div>
    </div>
  );
}

export const MissingRuntimeDialog = memo(MissingRuntimeDialogBase);
