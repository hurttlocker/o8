'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  THEME_ACCENT,
  THEME_ACCENT_SOFT,
  THEME_ACCENT_BORDER,
  THEME_ACCENT_RING,
} from './shared';

// ── Types ──

interface DiagnosticTool {
  id: string;
  detected: boolean;
  version?: string;
  path?: string;
}

interface CodexSessionsPruneResult {
  archiveRoot: string | null;
  candidates: number;
  deleted: number;
  durationMs: number;
  maxAgeDays: number;
  missingCwd: number;
  mode: 'archive' | 'delete';
  moved: number;
  olderThanDays: number;
  scanned: number;
  sessionsRoot: string;
  skipped: number;
}

const HIDDEN_DIAGNOSTIC_TOOL_IDS = new Set(['ollama']);

function formatDuration(durationMs: number) {
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }

  return `${(durationMs / 1000).toFixed(1)}s`;
}

// ── Diagnostics Tab ──

export function DiagnosticsTab() {
  const [tools, setTools] = useState<DiagnosticTool[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastChecked, setLastChecked] = useState<string | null>(null);
  const [pruneBusy, setPruneBusy] = useState(false);
  const [pruneError, setPruneError] = useState<string | null>(null);
  const [pruneResult, setPruneResult] = useState<CodexSessionsPruneResult | null>(null);

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

  const runPrune = useCallback(async () => {
    setPruneBusy(true);
    setPruneError(null);
    setPruneResult(null);
    try {
      const res = await fetch('/api/panel/codex-sessions/prune', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'archive', maxAgeDays: 14 }),
      });
      const data = await res.json().catch(() => ({})) as {
        error?: string;
        result?: CodexSessionsPruneResult;
      };
      if (!res.ok || !data.result) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setPruneResult(data.result);
    } catch (err) {
      setPruneError(err instanceof Error ? err.message : 'Failed to prune codex sessions');
    } finally {
      setPruneBusy(false);
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

      <div style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        padding: '16px 18px',
        borderRadius: 16,
        background: `linear-gradient(180deg, ${THEME_ACCENT_SOFT} 0%, var(--t-bg-card, rgba(148, 163, 184, 0.06)) 100%)`,
        border: `1px solid ${THEME_ACCENT_BORDER}`,
        boxShadow: `0 18px 36px ${THEME_ACCENT_RING}`,
      }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 560 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--t-text)', letterSpacing: '-0.02em' }}>
              Codex session archive prune
            </div>
            <div style={{ fontSize: 12, lineHeight: 1.55, color: 'var(--t-text-muted)' }}>
              Move stale Codex session transcripts older than 14 days, or pointing at missing worktrees, out of
              <span style={{ fontFamily: '"SF Mono", ui-monospace, monospace', color: 'var(--t-text-secondary)' }}> ~/.codex/sessions/</span>
              {' '}into
              <span style={{ fontFamily: '"SF Mono", ui-monospace, monospace', color: 'var(--t-text-secondary)' }}> ~/.codex/sessions-archive/</span>
              . This only runs when you trigger it here.
            </div>
          </div>
          <button
            type="button"
            onClick={() => { void runPrune(); }}
            disabled={pruneBusy}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              minWidth: 164,
              padding: '9px 14px',
              borderRadius: 10,
              border: `1px solid ${THEME_ACCENT_BORDER}`,
              background: pruneBusy ? THEME_ACCENT_SOFT : THEME_ACCENT,
              color: pruneBusy ? THEME_ACCENT : 'var(--t-bg, #ffffff)',
              fontSize: 12,
              fontWeight: 700,
              cursor: pruneBusy ? 'wait' : 'pointer',
              boxShadow: pruneBusy ? 'none' : `0 12px 28px ${THEME_ACCENT_RING}`,
              transition: 'background 180ms ease, box-shadow 180ms ease, opacity 180ms ease',
              opacity: pruneBusy ? 0.85 : 1,
            }}
          >
            {pruneBusy ? 'Pruning...' : 'Prune old sessions'}
          </button>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {[
            'Archive-first',
            '14-day stale window',
            'Missing worktree cleanup',
          ].map((label) => (
            <div
              key={label}
              style={{
                padding: '5px 10px',
                borderRadius: 999,
                fontSize: 11,
                fontWeight: 600,
                color: 'var(--t-text-secondary)',
                background: 'var(--t-bg-card, rgba(148, 163, 184, 0.06))',
                border: '1px solid var(--t-divider-subtle, rgba(148, 163, 184, 0.12))',
              }}
            >
              {label}
            </div>
          ))}
        </div>

        {pruneError ? (
          <div style={{
            padding: '12px 14px',
            borderRadius: 12,
            background: 'rgba(239, 68, 68, 0.06)',
            border: '1px solid rgba(239, 68, 68, 0.15)',
            color: '#ef4444',
            fontSize: 13,
          }}>
            {pruneError}
          </div>
        ) : null}

        {pruneResult ? (
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            padding: '14px 16px',
            borderRadius: 14,
            background: 'var(--t-bg-card, rgba(148, 163, 184, 0.06))',
            border: `1px solid ${THEME_ACCENT_BORDER}`,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--t-text)' }}>
                Prune finished in {formatDuration(pruneResult.durationMs)}
              </div>
              <div style={{ fontSize: 12, color: 'var(--t-text-muted)' }}>
                Scanned {pruneResult.scanned} session files
              </div>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {[
                `${pruneResult.moved} archived`,
                `${pruneResult.deleted} deleted`,
                `${pruneResult.missingCwd} missing cwd`,
                `${pruneResult.olderThanDays} older than ${pruneResult.maxAgeDays}d`,
                `${pruneResult.skipped} skipped`,
              ].map((label) => (
                <div
                  key={label}
                  style={{
                    padding: '6px 10px',
                    borderRadius: 999,
                    fontSize: 11,
                    fontWeight: 700,
                    color: label.endsWith('skipped') && pruneResult.skipped > 0 ? 'var(--t-warning, #c2410c)' : 'var(--t-text-secondary)',
                    background: label.endsWith('skipped') && pruneResult.skipped > 0
                      ? 'var(--t-warning-soft, rgba(249, 115, 22, 0.12))'
                      : 'var(--t-bg-card, rgba(148, 163, 184, 0.06))',
                    border: label.endsWith('skipped') && pruneResult.skipped > 0
                      ? '1px solid var(--t-warning-border, rgba(249, 115, 22, 0.22))'
                      : '1px solid var(--t-divider-subtle, rgba(148, 163, 184, 0.1))',
                  }}
                >
                  {label}
                </div>
              ))}
            </div>
            {pruneResult.archiveRoot ? (
              <div style={{ fontSize: 12, color: 'var(--t-text-muted)', lineHeight: 1.5 }}>
                Archived transcripts were moved to
                <span style={{ fontFamily: '"SF Mono", ui-monospace, monospace', color: 'var(--t-text-secondary)' }}> {pruneResult.archiveRoot}</span>
                .
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
