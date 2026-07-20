'use client';

/**
 * OnboardingDispatchStep — first-run wizard step that lets the user pick
 * the default dispatch runtime (Codex / Claude Code / Gemini) for every
 * mission packet they ship.
 *
 * Writes to operator-defaults.json via POST /api/panel/operator-defaults
 * (same-origin loopback passes the middleware gate automatically).
 *
 * Smart default:
 *   1. If exactly one of codex/claude-code/gemini is detected, preselect it.
 *   2. If multiple are detected, default to 'codex' (system default).
 *   3. If none are detected, default to 'codex' and let the user override.
 *
 * Extracted from Onboarding.tsx to keep that file under the 800-line ceiling.
 */

import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';

import {
  ORCHESTRATOR_RUNTIMES,
  V1_DISPATCH_RUNTIMES,
} from '@/lib/orchestrator/runtime-capabilities';
import type { OrchestratorRuntime } from '@/lib/orchestrator/types';
import { getRuntimeInstallInfo } from '@/lib/setup/runtime-install';

const FONT = 'var(--font-sans-system)';
const MONO = '"SF Mono", ui-monospace, monospace';

export interface OnboardingRuntimeDetection {
  id: string;
  detected: boolean;
  version?: string;
}

function isDispatchRuntime(value: unknown): value is OrchestratorRuntime {
  return typeof value === 'string'
    && ORCHESTRATOR_RUNTIMES[value as OrchestratorRuntime]?.dispatchable === true;
}

function pickSmartDefault(runtimes: OnboardingRuntimeDetection[]): OrchestratorRuntime {
  const detected = new Set(
    runtimes.filter((r) => r.detected).map((r) => r.id),
  );
  const dispatchable = V1_DISPATCH_RUNTIMES.filter((id) => detected.has(id));
  if (dispatchable.length === 1) return dispatchable[0];
  // Multiple or none → stick with the system default so nothing behaves
  // unexpectedly if the user skips the step without touching the picker.
  return 'codex';
}

// Inline SVG glyphs — match the Onboarding.tsx convention (raw SVG, no
// React icon components, keeps Tauri webview rendering reliable).

function CodexGlyph({ size = 22, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}

function ClaudeGlyph({ size = 22, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3l1.9 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.1-1.8L12 3z" />
      <path d="M19 14l.9 2 2.1.8-2.1.9L19 20l-.9-2.3-2.1-.9 2.1-.8z" />
    </svg>
  );
}

function GeminiGlyph({ size = 22, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3c3 3 3 15 0 18" />
      <path d="M12 3c-3 3-3 15 0 18" />
    </svg>
  );
}

function runtimeGlyph(runtime: OrchestratorRuntime, color: string): ReactNode {
  if (runtime === 'codex') return <CodexGlyph color={color} />;
  if (runtime === 'claude-code') return <ClaudeGlyph color={color} />;
  if (runtime === 'gemini') return <GeminiGlyph color={color} />;
  return null;
}

function RuntimeTile({
  runtime,
  selected,
  detected,
  version,
  onSelect,
}: {
  runtime: OrchestratorRuntime;
  selected: boolean;
  detected: boolean;
  version?: string;
  onSelect: () => void;
}) {
  const capability = ORCHESTRATOR_RUNTIMES[runtime];
  const accent = capability.accentColor;

  const base: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: 10,
    padding: '16px 18px',
    minHeight: 136,
    borderRadius: 14,
    border: selected
      ? `1.5px solid ${accent}`
      : '1px solid var(--t-glass-border-strong)',
    background: selected
      ? 'var(--t-glass-muted-strong)'
      : 'var(--t-glass-muted)',
    backdropFilter: 'blur(14px)',
    WebkitBackdropFilter: 'blur(14px)',
    color: 'var(--t-text)',
    cursor: 'pointer',
    textAlign: 'left',
    fontFamily: FONT,
    boxShadow: selected
      ? `0 14px 32px ${accent}33, inset 0 1px 0 rgba(255,255,255,0.08)`
      : '0 8px 20px rgba(0,0,0,0.05)',
    transition: 'background 180ms cubic-bezier(0.22, 1, 0.36, 1), border-color 180ms cubic-bezier(0.22, 1, 0.36, 1), box-shadow 180ms cubic-bezier(0.22, 1, 0.36, 1)',
    position: 'relative',
    overflow: 'hidden',
  };

  return (
    <button type="button" onClick={onSelect} style={base}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        width: '100%',
        gap: 10,
      }}>
        <div style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 40,
          height: 40,
          borderRadius: 10,
          background: `${accent}1f`,
          color: accent,
          flexShrink: 0,
        }}>
          {runtimeGlyph(runtime, accent)}
        </div>
        {detected && (
          <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            color: '#22c55e',
            padding: '3px 8px',
            borderRadius: 999,
            background: 'rgba(34,197,94,0.12)',
            border: '1px solid rgba(34,197,94,0.24)',
          }}>
            <span style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: '#22c55e',
              boxShadow: '0 0 6px rgba(34,197,94,0.5)',
            }} />
            Installed
          </span>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width: '100%' }}>
        <div style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 8,
          flexWrap: 'wrap',
        }}>
          <span style={{
            fontSize: 15,
            fontWeight: 700,
            letterSpacing: '-0.01em',
            color: 'var(--t-text-strong)',
          }}>
            {capability.label}
          </span>
          {version && (
            <span style={{
              fontSize: 10,
              fontWeight: 600,
              color: 'var(--t-text-muted)',
              fontFamily: '"SF Mono", ui-monospace, monospace',
            }}>
              v{version}
            </span>
          )}
        </div>
        <div style={{
          fontSize: 12,
          color: 'var(--t-text-secondary)',
          lineHeight: 1.5,
        }}>
          {capability.description}
        </div>
      </div>

      {selected && (
        <div style={{
          position: 'absolute',
          top: 10,
          right: 10,
          width: 22,
          height: 22,
          borderRadius: '50%',
          background: accent,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: `0 6px 14px ${accent}66`,
        }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
        </div>
      )}
    </button>
  );
}

export const OnboardingDispatchStep = memo(function OnboardingDispatchStep({
  runtimes,
  onContinue,
  onSkip,
  renderButton,
}: {
  runtimes: OnboardingRuntimeDetection[];
  onContinue: () => void;
  onSkip: () => void;
  /** Render-prop for the wizard's shared primary-button styling. */
  renderButton: (props: {
    label: string;
    onClick: () => void;
    disabled?: boolean;
  }) => ReactNode;
}) {
  const initialDefault = useMemo(() => pickSmartDefault(runtimes), [runtimes]);
  const [selected, setSelected] = useState<OrchestratorRuntime>(initialDefault);
  const [userSelected, setUserSelected] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runtimeById = useMemo(() => {
    const map = new Map<string, OnboardingRuntimeDetection>();
    for (const rt of runtimes) map.set(rt.id, rt);
    return map;
  }, [runtimes]);

  useEffect(() => {
    let alive = true;
    fetch('/api/panel/operator-defaults', { cache: 'no-store' })
      .then((res) => res.ok ? res.json() : null)
      .then((payload: { values?: { defaultDispatchRuntime?: unknown } } | null) => {
        const runtime = payload?.values?.defaultDispatchRuntime;
        if (alive && !userSelected && isDispatchRuntime(runtime) && V1_DISPATCH_RUNTIMES.includes(runtime)) {
          setSelected(runtime);
        }
      })
      .catch(() => { /* Keep the local smart default if settings are unavailable. */ });
    return () => { alive = false; };
  }, [userSelected]);

  const handleContinue = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/panel/operator-defaults', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaultDispatchRuntime: selected }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(typeof data?.error === 'string' ? data.error : `Save failed (${res.status})`);
        setSaving(false);
        return;
      }
      setSaving(false);
      onContinue();
    } catch {
      setError('Network error. You can set this later in Settings.');
      setSaving(false);
    }
  }, [selected, onContinue]);

  return (
    <div style={{
      maxWidth: 720,
      width: '100%',
      display: 'flex',
      flexDirection: 'column',
      gap: 16,
    }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5, textAlign: 'center' }}>
        <div style={{
          fontSize: 13,
          color: 'var(--t-text-secondary)',
          lineHeight: 1.5,
        }}>
          Every packet you ship goes to one runtime by default. You can override per packet or change this later in Settings.
        </div>
        <div style={{ fontSize: 12, color: 'var(--t-text-faint)', lineHeight: 1.5 }}>
          A <span style={{ color: 'var(--t-text-muted)', fontWeight: 500 }}>packet</span> is one task you hand to an agent; <span style={{ color: 'var(--t-text-muted)', fontWeight: 500 }}>dispatch</span> is sending it off.
        </div>
      </div>

      <div style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${V1_DISPATCH_RUNTIMES.length}, minmax(0, 1fr))`,
        gap: 10,
      }}>
        {V1_DISPATCH_RUNTIMES.map((runtime) => {
          const det = runtimeById.get(runtime);
          return (
            <RuntimeTile
              key={runtime}
              runtime={runtime}
              selected={selected === runtime}
              detected={det?.detected ?? false}
              version={det?.version}
              onSelect={() => {
                setUserSelected(true);
                setSelected(runtime);
              }}
            />
          );
        })}
      </div>

      {/* #633 — when the selected runtime isn't installed, surface the install
          command inline so the user knows what they're committing to instead
          of discovering the gap at dispatch time. */}
      {(() => {
        const detected = runtimeById.get(selected)?.detected ?? false;
        if (detected) return null;
        const info = getRuntimeInstallInfo(selected);
        if (!info) return null;
        return (
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            padding: '12px 14px',
            borderRadius: 12,
            border: '1px solid rgba(245, 158, 11, 0.24)',
            background: 'rgba(245, 158, 11, 0.08)',
            color: 'var(--t-text-secondary)',
            fontSize: 12,
            lineHeight: 1.5,
          }}>
            <div style={{ fontWeight: 600, color: 'var(--t-text-strong)', fontFamily: FONT }}>
              {info.label} isn&apos;t installed yet.
            </div>
            <div style={{ fontFamily: FONT }}>
              {info.hint} You can still continue — dispatch will be disabled until it&apos;s on your PATH.
            </div>
            {info.command ? (
              <code style={{
                display: 'block',
                padding: '6px 10px',
                borderRadius: 8,
                background: 'var(--t-glass-muted)',
                border: '1px solid var(--t-glass-border-strong)',
                fontFamily: MONO,
                fontSize: 11.5,
                color: 'var(--t-text)',
                userSelect: 'all',
              }}>{info.command}</code>
            ) : null}
            {info.link ? (
              <a
                href={info.link}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  fontSize: 11.5,
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
        );
      })()}

      {error && (
        <div style={{
          fontSize: 12,
          color: '#ef4444',
          textAlign: 'center',
        }}>
          {error}
        </div>
      )}

      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginTop: 8,
      }}>
        <button
          type="button"
          onClick={onSkip}
          style={{
            border: 'none',
            background: 'transparent',
            color: 'var(--t-text-faint)',
            fontSize: 12,
            cursor: 'pointer',
            fontFamily: FONT,
            padding: 0,
          }}
        >
          Skip
        </button>
        {renderButton({
          label: saving ? 'Saving…' : 'Continue',
          onClick: handleContinue,
          disabled: saving,
        })}
      </div>
    </div>
  );
});
