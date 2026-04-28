'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  APP_FONT_STACK,
  MONO_FONT_STACK,
  RAMS_ACCENT,
  RAMS_HAIRLINE,
  RAMS_HAIRLINE_SOFT,
  RAMS_INK_QUIET,
  BracketLabel,
  HairlineRule,
  RamsButton,
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

interface FactoryResetResult {
  dataDir: string;
  removed: string[];
  failed: { entry: string; error: string }[];
  durationMs: number;
}

type FactoryResetStage = 'idle' | 'confirm' | 'busy' | 'done' | 'error';

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
  const [resetStage, setResetStage] = useState<FactoryResetStage>('idle');
  const [resetConfirmText, setResetConfirmText] = useState('');
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetResult, setResetResult] = useState<FactoryResetResult | null>(null);

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

  const openResetConfirm = useCallback(() => {
    setResetConfirmText('');
    setResetError(null);
    setResetResult(null);
    setResetStage('confirm');
  }, []);

  const cancelReset = useCallback(() => {
    if (resetStage === 'busy') return;
    setResetStage('idle');
    setResetConfirmText('');
    setResetError(null);
  }, [resetStage]);

  const dismissResetDone = useCallback(() => {
    // Even after success the user is supposed to quit + reopen. We close the
    // modal but leave a banner via resetResult so they don't lose context.
    setResetStage('idle');
  }, []);

  const runFactoryReset = useCallback(async () => {
    setResetStage('busy');
    setResetError(null);
    setResetResult(null);
    try {
      const res = await fetch('/api/panel/factory-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: 'RESET' }),
      });
      const data = await res.json().catch(() => ({})) as {
        error?: string;
        result?: FactoryResetResult;
      };
      if (!res.ok || !data.result) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setResetResult(data.result);
      setResetStage('done');
    } catch (err) {
      setResetError(err instanceof Error ? err.message : 'Factory reset failed');
      setResetStage('error');
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
          paddingTop: 2,
          paddingBottom: 2,
          fontSize: 13,
          color: 'var(--t-text)',
          lineHeight: 1.55,
        }}>
          <span style={{
            fontFamily: MONO_FONT_STACK,
            fontSize: 11,
            fontWeight: 500,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            color: '#ef4444',
            marginRight: 8,
          }}>
            [error]
          </span>
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
            paddingTop: 2,
            paddingBottom: 2,
            fontSize: 13,
            color: 'var(--t-text)',
            lineHeight: 1.55,
          }}>
            <span style={{
              fontFamily: MONO_FONT_STACK,
              fontSize: 11,
              fontWeight: 500,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color: '#ef4444',
              marginRight: 8,
            }}>
              [error]
            </span>
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

      {/* 03 — DANGER */}
      <section style={{ marginTop: 32 }}>
        <SectionLabel number="03">DANGER</SectionLabel>

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
              Factory reset
            </div>
            <div style={{ fontSize: 13, color: 'var(--t-text-secondary)', lineHeight: 1.55 }}>
              Wipes the contents of <span style={{ fontFamily: MONO_FONT_STACK, fontSize: 12 }}>~/.o8</span>{' '}
              — sessions, mission state, encrypted API keys, watched repos, and the WS token.
              You will need to quit and reopen o8 afterward to reinitialize. The legacy{' '}
              <span style={{ fontFamily: MONO_FONT_STACK, fontSize: 12 }}>~/.cortex-ide</span>{' '}
              dir is left in place as a rollback safety net.
            </div>
          </div>
          <RamsButton variant="danger" onClick={openResetConfirm}>
            factory reset ›
          </RamsButton>
        </div>

        {resetResult && resetStage === 'idle' ? (
          <div style={{
            marginTop: 14,
            paddingTop: 12,
            paddingBottom: 12,
            borderBottom: `1px solid ${RAMS_HAIRLINE_SOFT}`,
          }}>
            <div style={{
              fontSize: 13,
              color: 'var(--t-text)',
              lineHeight: 1.55,
              marginBottom: 8,
            }}>
              Reset complete in {resetResult.durationMs}ms. Quit and reopen o8 to reinitialize.
            </div>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
              <BracketLabel tone="quiet">{resetResult.removed.length} removed</BracketLabel>
              {resetResult.failed.length > 0
                ? <BracketLabel tone="accent">{resetResult.failed.length} failed</BracketLabel>
                : null}
            </div>
          </div>
        ) : null}

        <div style={{ marginTop: 20 }}>
          <HairlineRule />
        </div>
      </section>

      {/* Two-step confirmation modal */}
      {resetStage === 'confirm' || resetStage === 'busy' || resetStage === 'error' ? (
        <ResetConfirmModal
          stage={resetStage}
          confirmText={resetConfirmText}
          onConfirmTextChange={setResetConfirmText}
          error={resetError}
          onCancel={cancelReset}
          onSubmit={() => { void runFactoryReset(); }}
        />
      ) : null}

      {resetStage === 'done' && resetResult ? (
        <ResetDoneModal
          result={resetResult}
          onDismiss={dismissResetDone}
        />
      ) : null}
    </div>
  );
}

// ── Reset modals ──

function ResetConfirmModal({
  stage,
  confirmText,
  onConfirmTextChange,
  error,
  onCancel,
  onSubmit,
}: {
  stage: FactoryResetStage;
  confirmText: string;
  onConfirmTextChange: (v: string) => void;
  error: string | null;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const ready = confirmText === 'RESET' && stage !== 'busy';

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      background: 'rgba(0, 0, 0, 0.42)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 1000,
      fontFamily: APP_FONT_STACK,
    }}>
      <div style={{
        width: 480,
        maxWidth: '90vw',
        background: 'var(--t-bg-card, #ffffff)',
        border: `1px solid ${RAMS_HAIRLINE}`,
        borderRadius: 4,
        paddingTop: 24,
        paddingRight: 28,
        paddingBottom: 24,
        paddingLeft: 28,
        boxShadow: '0 12px 48px rgba(0, 0, 0, 0.18)',
      }}>
        <div style={{
          fontFamily: MONO_FONT_STACK,
          fontSize: 10,
          fontWeight: 500,
          letterSpacing: '0.22em',
          textTransform: 'uppercase',
          color: '#d94f3a',
          marginBottom: 14,
        }}>
          ⏵ DANGER · IRREVERSIBLE
        </div>
        <div style={{
          fontSize: 18,
          fontWeight: 500,
          color: 'var(--t-text)',
          letterSpacing: '-0.02em',
          marginBottom: 14,
        }}>
          Factory reset o8
        </div>
        <div style={{ fontSize: 13, color: 'var(--t-text-secondary)', lineHeight: 1.55, marginBottom: 18 }}>
          This will permanently delete everything inside{' '}
          <span style={{ fontFamily: MONO_FONT_STACK, fontSize: 12 }}>~/.o8</span>:
        </div>
        <ul style={{
          fontSize: 13,
          color: 'var(--t-text-secondary)',
          lineHeight: 1.7,
          paddingLeft: 18,
          marginTop: 0,
          marginBottom: 18,
        }}>
          <li>SQLite database (sessions, approvals, lanes, watched agents)</li>
          <li>Encrypted API keys (Anthropic, OpenAI, Gemini, etc.)</li>
          <li>Mission state and orchestrator history</li>
          <li>Watched repo registry, directives, WS token</li>
          <li>Per-server logs</li>
        </ul>
        <div style={{ fontSize: 13, color: 'var(--t-text-secondary)', lineHeight: 1.55, marginBottom: 18 }}>
          The macOS Keychain master key and{' '}
          <span style={{ fontFamily: MONO_FONT_STACK, fontSize: 12 }}>~/.cortex-ide</span>{' '}
          (legacy rollback dir) are left untouched.
        </div>
        <div style={{ marginBottom: 14 }}>
          <div style={{
            fontFamily: MONO_FONT_STACK,
            fontSize: 10,
            fontWeight: 400,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: RAMS_INK_QUIET,
            marginBottom: 6,
          }}>
            Type RESET to confirm
          </div>
          <input
            type="text"
            value={confirmText}
            onChange={(event) => onConfirmTextChange(event.target.value)}
            disabled={stage === 'busy'}
            autoFocus
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            style={{
              width: '100%',
              boxSizing: 'border-box',
              fontFamily: MONO_FONT_STACK,
              fontSize: 13,
              fontWeight: 400,
              letterSpacing: '0.04em',
              color: 'var(--t-text)',
              background: 'var(--t-input-bg, transparent)',
              border: `1px solid ${RAMS_HAIRLINE}`,
              borderRadius: 4,
              paddingTop: 9,
              paddingRight: 12,
              paddingBottom: 9,
              paddingLeft: 12,
              outline: 'none',
            }}
          />
        </div>
        {error ? (
          <div style={{
            marginBottom: 14,
            paddingTop: 2,
            paddingBottom: 2,
            fontSize: 12,
            color: 'var(--t-text)',
            lineHeight: 1.5,
          }}>
            <span style={{
              fontFamily: MONO_FONT_STACK,
              fontSize: 11,
              fontWeight: 500,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color: '#ef4444',
              marginRight: 8,
            }}>
              [error]
            </span>
            {error}
          </div>
        ) : null}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 6 }}>
          <RamsButton variant="ghost" onClick={onCancel} disabled={stage === 'busy'}>
            cancel
          </RamsButton>
          <RamsButton
            variant="danger"
            onClick={onSubmit}
            disabled={!ready}
            busy={stage === 'busy'}
          >
            {stage === 'busy' ? 'wiping...' : 'reset everything'}
          </RamsButton>
        </div>
      </div>
    </div>
  );
}

function ResetDoneModal({
  result,
  onDismiss,
}: {
  result: FactoryResetResult;
  onDismiss: () => void;
}) {
  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      background: 'rgba(0, 0, 0, 0.42)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 1000,
      fontFamily: APP_FONT_STACK,
    }}>
      <div style={{
        width: 460,
        maxWidth: '90vw',
        background: 'var(--t-bg-card, #ffffff)',
        border: `1px solid ${RAMS_HAIRLINE}`,
        borderRadius: 4,
        paddingTop: 24,
        paddingRight: 28,
        paddingBottom: 24,
        paddingLeft: 28,
        boxShadow: '0 12px 48px rgba(0, 0, 0, 0.18)',
      }}>
        <div style={{
          fontFamily: MONO_FONT_STACK,
          fontSize: 10,
          fontWeight: 500,
          letterSpacing: '0.22em',
          textTransform: 'uppercase',
          color: RAMS_ACCENT,
          marginBottom: 14,
        }}>
          ⏵ RESET COMPLETE
        </div>
        <div style={{
          fontSize: 18,
          fontWeight: 500,
          color: 'var(--t-text)',
          letterSpacing: '-0.02em',
          marginBottom: 12,
        }}>
          Quit and reopen o8 to reinitialize
        </div>
        <div style={{ fontSize: 13, color: 'var(--t-text-secondary)', lineHeight: 1.55, marginBottom: 16 }}>
          {result.removed.length} entries removed in {result.durationMs}ms.{' '}
          {result.failed.length > 0
            ? `${result.failed.length} entries could not be deleted (likely held open by the running app — they will be cleared on next launch).`
            : 'The current session is still running against the deleted database — close o8 fully and relaunch before continuing.'}
        </div>
        <div style={{
          fontFamily: MONO_FONT_STACK,
          fontSize: 11,
          letterSpacing: '0.02em',
          color: RAMS_INK_QUIET,
          marginBottom: 18,
          wordBreak: 'break-all',
        }}>
          {result.dataDir}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <RamsButton variant="ghost" onClick={onDismiss}>
            close
          </RamsButton>
        </div>
      </div>
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
    minHeight: 44,
    paddingLeft: 14,
    paddingRight: 14,
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
