'use client';

/**
 * RuntimeRow — single row in the Onboarding step 3 runtime list.
 *
 * Renders a green-dot "Ready" state when a runtime is detected, and an
 * inline install command + skip hint when it isn't. Extracted from
 * Onboarding.tsx so we can keep that file under the 800-line ceiling
 * after issue #633 added the remediation surface.
 */

import { memo, useState } from 'react';
import { getRuntimeInstallInfo } from '@/lib/setup/runtime-install';

const FONT = 'var(--font-sans-system)';
const MONO = '"SF Mono", ui-monospace, monospace';

export interface DetectedRuntimeRow {
  id: string;
  name: string;
  detected: boolean;
  ready?: boolean;
  authHint?: string;
  version?: string;
}

function CopyChip({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        try {
          void navigator.clipboard?.writeText(command);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1600);
        } catch {
          /* clipboard may be unavailable */
        }
      }}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        paddingTop: 6,
        paddingBottom: 6,
        paddingLeft: 10,
        paddingRight: 10,
        borderRadius: 8,
        border: '1px solid var(--t-glass-border-strong)',
        background: copied ? 'rgba(34, 197, 94, 0.12)' : 'var(--t-glass-muted)',
        color: copied ? '#22c55e' : 'var(--t-text-secondary)',
        fontSize: 11,
        fontFamily: MONO,
        cursor: 'pointer',
        flexShrink: 0,
        transition: 'background 150ms cubic-bezier(0.22, 1, 0.36, 1), color 150ms cubic-bezier(0.22, 1, 0.36, 1)',
      }}
      title={copied ? 'Copied' : 'Copy install command'}
    >
      <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {copied ? (
          <path d="M20 6L9 17l-5-5" />
        ) : (
          <>
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </>
        )}
      </svg>
      <span>{copied ? 'Copied' : command}</span>
    </button>
  );
}

function RuntimeRowBase({ runtime }: { runtime: DetectedRuntimeRow }) {
  const info = getRuntimeInstallInfo(runtime.id);
  const detected = runtime.detected;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: '12px 16px',
        borderRadius: 14,
        background: 'var(--t-glass-muted-strong)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        border: '1px solid var(--t-glass-border-strong)',
      } as React.CSSProperties}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div
          style={{
            width: 10,
            height: 10,
            borderRadius: '50%',
            background: !detected ? 'var(--t-text-faint)' : runtime.ready === false ? '#f59e0b' : '#22c55e',
            boxShadow: detected && runtime.ready !== false ? '0 0 8px rgba(34, 197, 94, 0.3)' : 'none',
            flexShrink: 0,
          }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-text)', fontFamily: FONT }}>
            {runtime.name}
          </div>
          <div style={{ fontSize: 11, color: !detected ? 'var(--t-text-faint)' : runtime.ready === false ? '#b45309' : '#22c55e', marginTop: 1, fontFamily: FONT }}>
            {!detected ? 'Not installed' : runtime.ready === false ? (runtime.authHint ?? 'Auth needed') : (runtime.version ? `v${runtime.version} — ready` : 'Ready')}
          </div>
        </div>
        {detected && (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M20 6L9 17l-5-5" />
          </svg>
        )}
      </div>
      {!detected && info ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 22 }}>
          <div style={{ fontSize: 11, color: 'var(--t-text-muted)', lineHeight: 1.45, fontFamily: FONT }}>
            {info.hint}
          </div>
          {info.command ? <CopyChip command={info.command} /> : null}
          {info.link ? (
            <a
              href={info.link}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: 'var(--t-accent)',
                textDecoration: 'none',
                fontFamily: FONT,
              }}
            >
              {info.link.replace(/^https?:\/\//, '')} →
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export const RuntimeRow = memo(RuntimeRowBase);
