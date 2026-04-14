'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  THEME_ACCENT,
  THEME_ACCENT_SOFT,
  THEME_ACCENT_BORDER,
} from './shared';

// ── Types ──

interface DiagnosticTool {
  id: string;
  detected: boolean;
  version?: string;
  path?: string;
}

const HIDDEN_DIAGNOSTIC_TOOL_IDS = new Set(['ollama']);

// ── Diagnostics Tab ──

export function DiagnosticsTab() {
  const [tools, setTools] = useState<DiagnosticTool[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastChecked, setLastChecked] = useState<string | null>(null);

  const runDiagnostics = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/setup/detect');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { tools?: DiagnosticTool[] };
      setTools((data.tools ?? []).filter((tool) => !HIDDEN_DIAGNOSTIC_TOOL_IDS.has(tool.id)));
      setLastChecked(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to run diagnostics');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void runDiagnostics(); }, [runDiagnostics]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--t-text)', letterSpacing: '-0.02em' }}>Diagnostics</div>
          <div style={{ fontSize: 12, color: 'var(--t-text-muted)', marginTop: 2 }}>
            {lastChecked ? `Last checked at ${lastChecked}` : 'Runtime and tool health'}
          </div>
        </div>
        <button
          type="button"
          onClick={() => { void runDiagnostics(); }}
          disabled={loading}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '6px 14px',
            borderRadius: 8,
            border: `1px solid ${THEME_ACCENT_BORDER}`,
            background: THEME_ACCENT_SOFT,
            color: THEME_ACCENT,
            fontSize: 12,
            fontWeight: 600,
            cursor: loading ? 'wait' : 'pointer',
            opacity: loading ? 0.6 : 1,
          }}
        >
          {loading ? 'Checking...' : 'Re-run'}
        </button>
      </div>

      {error ? (
        <div style={{
          padding: '12px 16px',
          borderRadius: 10,
          background: 'rgba(239, 68, 68, 0.06)',
          border: '1px solid rgba(239, 68, 68, 0.15)',
          color: '#ef4444',
          fontSize: 13,
        }}>
          {error}
        </div>
      ) : null}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {tools.map((tool) => (
          <div key={tool.id} style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '10px 14px',
            borderRadius: 10,
            background: 'var(--t-bg-card, rgba(148, 163, 184, 0.06))',
            border: '1px solid var(--t-divider-subtle, rgba(148, 163, 184, 0.10))',
          }}>
            <div style={{
              width: 8,
              height: 8,
              borderRadius: 999,
              background: tool.detected ? '#22c55e' : '#ef4444',
              flexShrink: 0,
            }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-text)' }}>{tool.id}</div>
              {tool.path ? (
                <div style={{ fontSize: 11, color: 'var(--t-text-muted)', fontFamily: '"SF Mono", ui-monospace, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {tool.path}
                </div>
              ) : null}
            </div>
            <div style={{
              fontSize: 11,
              fontWeight: 600,
              color: tool.detected ? 'var(--t-text-secondary)' : '#ef4444',
              fontFamily: '"SF Mono", ui-monospace, monospace',
            }}>
              {tool.detected ? (tool.version ?? 'detected') : 'not found'}
            </div>
          </div>
        ))}
        {!loading && tools.length === 0 && !error ? (
          <div style={{ fontSize: 13, color: 'var(--t-text-muted)', padding: '20px 0', textAlign: 'center' }}>
            No tools detected. Run diagnostics to check your environment.
          </div>
        ) : null}
      </div>
    </div>
  );
}
