'use client';

import { memo, useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { RuntimeRow } from './RuntimeRow';
import type { OnboardingRequest } from './request';

const FONT = 'var(--font-sans-system)';

export interface DetectedRuntime {
  id: string;
  name: string;
  detected: boolean;
  ready?: boolean;
  authHint?: string;
  version?: string;
}

interface DetectPayload {
  tools?: Array<{ id: string; name: string; detected: boolean; ready?: boolean; authHint?: string; version?: string }>;
  error?: string;
  partial?: boolean;
  timedOut?: boolean;
}

function Spinner({ size = 14 }: { size?: number }) {
  return (
    <div style={{
      width: size,
      height: size,
      borderRadius: '50%',
      border: '2px solid var(--t-text-faint)',
      borderTopColor: 'var(--t-accent)',
      animation: 'spin 1s linear infinite',
      flexShrink: 0,
    }} />
  );
}

function runtimeScanError(error: unknown) {
  if (error instanceof Error && error.message.trim()) return error.message;
  return 'Runtime scan failed. Check your connection and try again.';
}

export const OnboardingRuntimeStep = memo(function OnboardingRuntimeStep({
  request = fetch,
  runtimes,
  onRuntimesChange,
  onContinue,
  renderButton,
}: {
  request?: OnboardingRequest;
  runtimes: DetectedRuntime[];
  onRuntimesChange: (runtimes: DetectedRuntime[]) => void;
  onContinue: () => void;
  renderButton: (props: { label: string; onClick: () => void }) => ReactNode;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [partial, setPartial] = useState(false);

  const detectRuntimes = useCallback(async () => {
    setLoading(true);
    setError(null);
    setPartial(false);
    try {
      const res = await request('/api/setup/detect');
      const data = await res.json().catch(() => ({})) as DetectPayload;
      if (!res.ok) {
        throw new Error(data.error || `Runtime scan failed (${res.status})`);
      }
      const tools: DetectedRuntime[] = (data.tools ?? []).map((t) => ({
        id: t.id,
        name: t.name,
        detected: t.detected,
        ready: t.ready,
        authHint: t.authHint,
        version: t.version,
      }));
      onRuntimesChange(tools);
      setPartial(Boolean(data.partial || data.timedOut));
    } catch (scanError) {
      setError(runtimeScanError(scanError));
    } finally {
      setLoading(false);
    }
  }, [onRuntimesChange, request]);

  useEffect(() => {
    void detectRuntimes();
  }, [detectRuntimes]);

  const noDetectedRuntimes = runtimes.length > 0 && runtimes.every((rt) => !rt.detected);

  return (
    <div style={{ maxWidth: 520, width: '100%', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5, textAlign: 'center' }}>
        <div style={{ fontSize: 13, color: 'var(--t-text-secondary)', lineHeight: 1.5 }}>
          These power your assistant and agent sessions. No extra API keys needed.
        </div>
        <div style={{ fontSize: 12, color: 'var(--t-text-faint)', lineHeight: 1.5 }}>
          A <span style={{ color: 'var(--t-text-muted)', fontWeight: 500 }}>runtime</span> is the AI that writes the code — Codex, Claude, or Gemini. o8 uses whichever you have installed.
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {loading ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 24, justifyContent: 'center', color: 'var(--t-text-secondary)', fontSize: 13 }}>
            <Spinner /> Scanning for tools...
          </div>
        ) : error ? (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            padding: '12px 14px',
            borderRadius: 12,
            border: '1px solid var(--t-brand-red)',
            background: 'var(--t-bg-card)',
            color: 'var(--t-text-secondary)',
            fontSize: 12,
            lineHeight: 1.45,
            fontFamily: FONT,
          }}>
            <span style={{ flex: 1, minWidth: 0 }}>{error}</span>
            <button
              type="button"
              onClick={detectRuntimes}
              style={{
                border: '1px solid var(--t-brand-red)',
                background: 'transparent',
                color: 'var(--t-brand-red)',
                borderRadius: 9,
                paddingTop: 7,
                paddingBottom: 7,
                paddingLeft: 10,
                paddingRight: 10,
                fontSize: 11,
                fontWeight: 700,
                fontFamily: FONT,
                cursor: 'pointer',
                flexShrink: 0,
              }}
            >
              Retry
            </button>
          </div>
        ) : runtimes.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--t-text-muted)', fontSize: 13 }}>
            No agent runtimes detected. Install Claude Code, Codex, or Gemini to get started, or add API keys in Settings.
          </div>
        ) : (
          runtimes.map((rt) => <RuntimeRow key={rt.id} runtime={rt} />)
        )}
      </div>

      {!loading && !error && partial ? (
        <div style={{
          padding: '10px 12px',
          borderRadius: 10,
          border: '1px solid var(--t-divider-subtle)',
          background: 'var(--t-bg-card)',
          color: 'var(--t-text-secondary)',
          fontSize: 11,
          lineHeight: 1.5,
        }}>
          Runtime scan hit the 10 second limit. Showing partial results; retry if a tool is missing.
        </div>
      ) : null}

      {!loading && !error && noDetectedRuntimes ? (
        <div style={{
          padding: '10px 12px',
          borderRadius: 10,
          border: '1px solid var(--t-divider-subtle)',
          background: 'var(--t-bg-card)',
          color: 'var(--t-text-secondary)',
          fontSize: 11,
          lineHeight: 1.5,
        }}>
          No runtimes are installed yet. You can still continue; dispatching packets will be disabled until you install at least one CLI.
        </div>
      ) : null}

      {/* Live rescan — the detection scan reads well-known install dirs
          directly (no PATH dependency), so a CLI installed in Terminal while
          this screen is open shows up on the next scan, no app restart. */}
      {!loading && !error ? (
        <button
          type="button"
          onClick={detectRuntimes}
          style={{ alignSelf: 'center', display: 'inline-flex', alignItems: 'center', gap: 6, border: 'none', background: 'transparent', color: 'var(--t-text-muted)', fontSize: 11.5, fontWeight: 500, cursor: 'pointer', fontFamily: FONT, padding: 4 }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>
          Just installed one? Scan again
        </button>
      ) : null}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 }}>
        <button type="button" onClick={onContinue} style={{ border: 'none', background: 'transparent', color: 'var(--t-text-faint)', fontSize: 12, cursor: 'pointer', fontFamily: FONT, padding: 0 }}>Skip for now</button>
        {renderButton({
          label: !loading && noDetectedRuntimes ? 'Continue without runtimes' : 'Continue',
          onClick: onContinue,
        })}
      </div>
    </div>
  );
});
