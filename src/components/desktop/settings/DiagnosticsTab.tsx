'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  APP_FONT_STACK,
  MONO_FONT_STACK,
  RAMS_ACCENT,
  RAMS_HAIRLINE_SOFT,
  RAMS_INK_QUIET,
  BracketLabel,
  HairlineRule,
  SectionLabel,
  TabBreadcrumb,
  TabHeading,
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
    <div style={{
      paddingTop: 8,
      paddingLeft: 8,
      paddingRight: 32,
      paddingBottom: 40,
      maxWidth: 780,
      fontFamily: APP_FONT_STACK,
    }}>
      <TabBreadcrumb tab="diagnostics" />
      <TabHeading
        title="diagnostics"
        subtitle="Runtime and tool health. Quiet neutral dots when everything is fine; colored dots only when action is demanded."
      />

      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 20,
        marginBottom: 28,
        flexWrap: 'wrap',
      }}>
        <div style={{
          fontFamily: MONO_FONT_STACK,
          fontSize: 11,
          fontWeight: 400,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: RAMS_INK_QUIET,
        }}>
          {lastChecked ? `last checked ${lastChecked}` : 'not yet checked'}
        </div>
        <button
          type="button"
          onClick={() => { void runDiagnostics(); }}
          disabled={loading}
          style={accentLinkStyle(loading)}
        >
          {loading ? 'checking...' : 're-run ›'}
        </button>
      </div>

      {error ? (
        <div style={{
          marginBottom: 28,
          borderLeft: `2px solid #ef4444`,
          paddingLeft: 14,
          paddingTop: 2,
          paddingBottom: 2,
          fontSize: 13,
          color: 'var(--t-text)',
          lineHeight: 1.55,
        }}>
          {error}
        </div>
      ) : null}

      {/* 01 — RUNTIMES */}
      <section style={{ marginBottom: 32 }}>
        <SectionLabel number="01">RUNTIMES</SectionLabel>

        <div style={{ borderTop: `1px solid ${RAMS_HAIRLINE_SOFT}` }}>
          {tools.map((tool) => (
            <ToolRow key={tool.id} tool={tool} />
          ))}
          {!loading && tools.length === 0 && !error ? (
            <div style={{
              paddingTop: 14,
              paddingBottom: 14,
              fontSize: 13,
              color: RAMS_INK_QUIET,
              lineHeight: 1.55,
            }}>
              No tools detected. Re-run to check your environment.
            </div>
          ) : null}
        </div>
      </section>

      {/* 02 — MAINTENANCE */}
      <section>
        <SectionLabel number="02">MAINTENANCE</SectionLabel>

        <div style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 20,
          paddingTop: 4,
          paddingBottom: 16,
          borderBottom: `1px solid ${RAMS_HAIRLINE_SOFT}`,
          flexWrap: 'wrap',
        }}>
          <div style={{ flex: 1, minWidth: 0, maxWidth: 520 }}>
            <div style={{
              fontSize: 14,
              fontWeight: 500,
              color: 'var(--t-text)',
              marginBottom: 4,
              letterSpacing: '-0.01em',
            }}>
              Codex session archive prune
            </div>
            <div style={{ fontSize: 13, color: 'var(--t-text-secondary)', lineHeight: 1.55 }}>
              Move stale Codex session transcripts older than 14 days, or pointing at missing worktrees, from{' '}
              <span style={{ fontFamily: MONO_FONT_STACK, fontSize: 12 }}>~/.codex/sessions/</span>{' '}
              into{' '}
              <span style={{ fontFamily: MONO_FONT_STACK, fontSize: 12 }}>~/.codex/sessions-archive/</span>.
              Only runs when you trigger it here.
            </div>
          </div>
          <button
            type="button"
            onClick={() => { void runPrune(); }}
            disabled={pruneBusy}
            style={accentLinkStyle(pruneBusy)}
          >
            {pruneBusy ? 'pruning...' : 'prune old sessions ›'}
          </button>
        </div>

        {pruneError ? (
          <div style={{
            marginTop: 14,
            borderLeft: `2px solid #ef4444`,
            paddingLeft: 14,
            paddingTop: 2,
            paddingBottom: 2,
            fontSize: 13,
            color: 'var(--t-text)',
            lineHeight: 1.55,
          }}>
            {pruneError}
          </div>
        ) : null}

        {pruneResult ? (
          <div style={{
            marginTop: 14,
            paddingTop: 12,
            paddingBottom: 12,
            borderBottom: `1px solid ${RAMS_HAIRLINE_SOFT}`,
          }}>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 16,
              flexWrap: 'wrap',
              marginBottom: 12,
            }}>
              <span style={{
                fontSize: 14,
                fontWeight: 500,
                color: 'var(--t-text)',
                letterSpacing: '-0.01em',
              }}>
                Prune finished in {formatDuration(pruneResult.durationMs)}
              </span>
              <span style={{
                fontFamily: MONO_FONT_STACK,
                fontSize: 11,
                letterSpacing: '0.04em',
                color: RAMS_INK_QUIET,
              }}>
                scanned {pruneResult.scanned} files
              </span>
            </div>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              <BracketLabel tone="quiet">{pruneResult.moved} archived</BracketLabel>
              <BracketLabel tone="quiet">{pruneResult.deleted} deleted</BracketLabel>
              <BracketLabel tone="quiet">{pruneResult.missingCwd} missing cwd</BracketLabel>
              <BracketLabel tone="quiet">{pruneResult.olderThanDays} older than {pruneResult.maxAgeDays}d</BracketLabel>
              {pruneResult.skipped > 0
                ? <BracketLabel tone="accent">{pruneResult.skipped} skipped</BracketLabel>
                : <BracketLabel tone="quiet">0 skipped</BracketLabel>}
            </div>
            {pruneResult.archiveRoot ? (
              <div style={{
                marginTop: 10,
                fontFamily: MONO_FONT_STACK,
                fontSize: 11,
                letterSpacing: '0.02em',
                color: 'var(--t-text-secondary)',
                wordBreak: 'break-all',
              }}>
                {pruneResult.archiveRoot}
              </div>
            ) : null}
          </div>
        ) : null}

        <div style={{ marginTop: 20 }}>
          <HairlineRule />
        </div>
      </section>
    </div>
  );
}

function ToolRow({ tool }: { tool: DiagnosticTool }) {
  const dotColor = tool.detected ? RAMS_INK_QUIET : '#ef4444';
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 14,
      paddingTop: 12,
      paddingBottom: 12,
      borderBottom: `1px solid ${RAMS_HAIRLINE_SOFT}`,
    }}>
      <span style={{
        width: 6,
        height: 6,
        borderRadius: 3,
        background: dotColor,
        flexShrink: 0,
      }} />
      <span style={{
        fontFamily: MONO_FONT_STACK,
        fontSize: 11,
        fontWeight: 400,
        color: RAMS_INK_QUIET,
        textTransform: 'uppercase',
        letterSpacing: '0.14em',
        minWidth: 120,
      }}>
        {tool.id}
      </span>
      <span style={{
        fontSize: 13,
        fontWeight: 400,
        color: 'var(--t-text)',
        flex: 1,
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        fontFamily: tool.path ? MONO_FONT_STACK : APP_FONT_STACK,
        letterSpacing: tool.path ? '0.02em' : '-0.005em',
      }}>
        {tool.path || (tool.detected ? (tool.version ?? 'detected') : 'not found')}
      </span>
      <span style={{
        fontFamily: MONO_FONT_STACK,
        fontSize: 11,
        fontWeight: 400,
        letterSpacing: '0.04em',
        color: tool.detected ? 'var(--t-text-secondary)' : '#dc2626',
      }}>
        {tool.detected ? (tool.version ?? 'detected') : 'missing'}
      </span>
    </div>
  );
}

function accentLinkStyle(disabled: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    height: 30,
    paddingLeft: 12,
    paddingRight: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: disabled ? RAMS_HAIRLINE_SOFT : 'rgba(255, 90, 31, 0.32)',
    background: disabled ? 'transparent' : 'rgba(255, 90, 31, 0.1)',
    color: disabled ? RAMS_INK_QUIET : RAMS_ACCENT,
    fontFamily: MONO_FONT_STACK,
    fontSize: 11.5,
    fontWeight: 500,
    letterSpacing: '0.04em',
    textTransform: 'uppercase' as const,
    cursor: disabled ? 'default' : 'pointer',
    transition: 'background 150ms ease, border-color 150ms ease',
    opacity: disabled ? 0.6 : 1,
  };
}
