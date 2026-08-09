'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  APP_FONT_STACK,
  MONO_FONT_STACK,
  RAMS_ACCENT,
  RAMS_INK_QUIET,
  BracketLabel,
  RamsButton,
  ActivityIcon,
  PlugIcon,
  LayersIcon,
  TabHeading,
  SETTINGS_CONTENT_MAX_WIDTH,
} from './shared';
import { SettingsGroup, SettingsRow, ValuePill } from './grouped';
import { formatDuration } from '@/lib/format/duration';
import { RecallHealthSection } from './RecallHealthSection';
import { LoopStatusSection } from './LoopStatusSection';
import { DemoRunSection } from './DemoRunSection';
import {
  ResetConfirmModal,
  ResetDoneModal,
  type FactoryResetResult,
  type FactoryResetStage,
} from './DiagnosticsResetModals';
import { useEntitlement } from '@/lib/entitlement/context';

// ── Types ──

interface DiagnosticTool {
  id: string;
  detected: boolean;
  ready?: boolean;
  authHint?: string;
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

function formatToolLabel(id: string): string {
  if (id === 'opencode') return 'OpenCode 2';
  if (id === 'api-keys') return 'API keys';
  return id.split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

function toolStatusLine(tool: DiagnosticTool): string {
  if (!tool.detected) return 'Not found';
  if (tool.ready === false) return tool.authHint ?? 'Auth missing';
  return tool.path ?? tool.version ?? 'Detected';
}

// ── Diagnostics Tab ──

export function DiagnosticsTab() {
  const { founder } = useEntitlement();
  // INTERNAL instrumentation, not a founders perk (operator, 2026-07-06):
  // substrate-health reds and loop state are repair signals for the team, not
  // something any customer — founder included — should be reading into.
  // Gated to Founding Operator #1 (the builder) until a proper internal-role
  // flag exists. Dev builds always show it.
  const internalMode = founder?.operatorNumber === 1 || process.env.NODE_ENV !== 'production';
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
      maxWidth: SETTINGS_CONTENT_MAX_WIDTH,
      fontFamily: APP_FONT_STACK,
    }}>
      <TabHeading
        title="diagnostics"
        subtitle="Runtime and tool health. Quiet neutral dots when everything is fine; colored badges only when action is demanded."
      />

      {error ? (
        <div style={{
          marginTop: 20,
          paddingTop: 2,
          paddingBottom: 2,
          fontSize: 13,
          color: 'var(--t-text)',
          lineHeight: 1.55,
        }}>
          <span style={{
            fontFamily: MONO_FONT_STACK,
            fontSize: 11,
            fontWeight: 300,
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

      {/* Runtimes */}
      <section style={{ marginTop: 28 }}>
        <SettingsGroup
          header="Runtimes"
          footnote="Re-run any time to refresh detected versions, paths, and auth status."
        >
          <SettingsRow
            icon={<ActivityIcon />}
            label="Runtime diagnostics"
            subtitle={lastChecked ? `Last checked ${lastChecked}` : 'Not yet checked'}
            accessory={
              <RamsButton variant="ghost" onClick={() => { void runDiagnostics(); }} disabled={loading} busy={loading}>
                {loading ? 'Checking…' : 'Re-run'}
              </RamsButton>
            }
            divider={tools.length > 0 || (!loading && tools.length === 0)}
          />
          {tools.map((tool, index) => (
            <SettingsRow
              key={tool.id}
              icon={<PlugIcon />}
              label={formatToolLabel(tool.id)}
              subtitle={toolStatusLine(tool)}
              accessory={!tool.detected || tool.ready === false ? (
                <ValuePill tone="destructive">{!tool.detected ? 'Missing' : 'Needs auth'}</ValuePill>
              ) : undefined}
              divider={index < tools.length - 1}
            />
          ))}
          {!loading && tools.length === 0 && !error ? (
            <SettingsRow
              icon={<PlugIcon />}
              label="No tools detected"
              subtitle="Re-run to check your environment"
            />
          ) : null}
        </SettingsGroup>
      </section>

      {/* Maintenance */}
      <section style={{ marginTop: 28 }}>
        <SettingsGroup
          header="Maintenance"
          footnote="Moves stale Codex session transcripts older than 14 days, or pointing at missing worktrees, from ~/.codex/sessions/ into ~/.codex/sessions-archive/. Only runs when you trigger it here."
        >
          <SettingsRow
            icon={<LayersIcon />}
            label="Prune Codex session archive"
            subtitle="Archive sessions older than 14 days"
            accessory={
              <RamsButton variant="ghost" onClick={() => { void runPrune(); }} disabled={pruneBusy} busy={pruneBusy}>
                {pruneBusy ? 'Pruning…' : 'Prune'}
              </RamsButton>
            }
            divider={!!pruneError || !!pruneResult}
          />

          {pruneError ? (
            <div style={{
              paddingTop: 10,
              paddingRight: 14,
              paddingBottom: 10,
              paddingLeft: 14,
              fontSize: 13,
              color: 'var(--t-text)',
              lineHeight: 1.55,
            }}>
              <span style={{
                fontFamily: MONO_FONT_STACK,
                fontSize: 11,
                fontWeight: 300,
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
              paddingTop: 12,
              paddingRight: 14,
              paddingBottom: 14,
              paddingLeft: 14,
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
                  fontWeight: 300,
                  color: 'var(--t-text)',
                  letterSpacing: '-0.01em',
                }}>
                  Prune finished in {formatDuration(pruneResult.durationMs)}
                </span>
                <span style={{
                  fontFamily: APP_FONT_STACK,
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
        </SettingsGroup>
      </section>

      {/* Danger */}
      <section style={{ marginTop: 28 }}>
        <SettingsGroup
          header="Danger"
          footnote="You will need to quit and reopen o8 afterward to reinitialize. The legacy ~/.cortex-ide dir is left in place as a rollback safety net."
        >
          <SettingsRow
            icon={<TrashIcon />}
            label="Factory reset"
            subtitle="Wipes ~/.o8 — sessions, keys, mission state, watched repos"
            destructive
            accessory={
              <RamsButton variant="danger" onClick={openResetConfirm}>
                Factory reset
              </RamsButton>
            }
            divider={!!resetResult && resetStage === 'idle'}
          />

          {resetResult && resetStage === 'idle' ? (
            <div style={{
              paddingTop: 12,
              paddingRight: 14,
              paddingBottom: 14,
              paddingLeft: 14,
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
        </SettingsGroup>
      </section>

      {/* Builder instrumentation — Brain recall latency, autonomous-loop state,
          and the golden-demo runner. Internal-only: repair signals for the
          team, never customer-facing (not even founders). */}
      {internalMode ? (
        <>
          <div style={{
            marginTop: 40,
            marginBottom: 12,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            maxWidth: 620,
          }}>
            <span style={{
              fontFamily: APP_FONT_STACK,
              fontSize: 10,
              fontWeight: 400,
              letterSpacing: '0.2em',
              textTransform: 'uppercase',
              color: RAMS_ACCENT,
            }}>
              Internal
            </span>
            <div style={{ flex: 1, height: 1, background: 'var(--t-divider, rgba(17,17,17,0.06))' }} />
            <span style={{
              fontFamily: APP_FONT_STACK,
              fontSize: 10,
              fontWeight: 400,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color: RAMS_INK_QUIET,
            }}>
              Instrumentation
            </span>
          </div>

          {/* Constrained to the same 620 rhythm as every group above — these
              cards previously spanned the full content width and read detached. */}
          <div style={{ maxWidth: 620 }}>
            {/* Recall health (#749 substrate eval gate) */}
            <section style={{ marginTop: 20 }}>
              <RecallHealthSection />
            </section>

            {/* Loop status (#796 in-app dogfood-loop visibility) */}
            <section style={{ marginTop: 28 }}>
              <LoopStatusSection />
            </section>

            {/* Demo sequence (#800 in-app golden-path runner) */}
            <section style={{ marginTop: 28 }}>
              <DemoRunSection />
            </section>
          </div>
        </>
      ) : null}

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

function TrashIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </svg>
  );
}
