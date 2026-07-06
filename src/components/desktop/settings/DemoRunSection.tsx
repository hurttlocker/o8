'use client';

/**
 * #800 — In-app demo-sequence runner UI.
 *
 * Sits inside Settings → Diagnostics and lets the operator press a single
 * button to drive the live o8 webview through the golden demo path. Each
 * step renders as an Issues-style row with status pill, ms timing, and an
 * expandable detail block (screenshot path + message).
 *
 * Result shape comes back from POST /api/panel/diagnostics/run-demo. We
 * keep the most recent run cached in component state — refreshing the tab
 * loses it, which is fine; the run is idempotent and safe to repeat.
 *
 * Design rules followed:
 *   - Inline styles only / palette tokens only / Phosphor SVG only
 *   - system UI for chrome / MONO for ms timing + paths
 *   - Issues-style rows: dot + uppercase mono label + value + hint
 *   - 800-line ceiling
 */

import { useCallback, useState } from 'react';
import {
  APP_FONT_STACK,
  MONO_FONT_STACK,
  RAMS_ACCENT,
  RAMS_HAIRLINE_SOFT,
  RAMS_INK_QUIET,
} from './shared';
import { GroupHeader, GroupFootnote } from './grouped';

// ── Types (mirror runDemoSequence's output) ──

type DemoStepStatus = 'pass' | 'fail' | 'skipped' | 'unavailable';

interface DemoStepResult {
  name: string;
  status: DemoStepStatus;
  ms: number;
  screenshotPath?: string;
  message?: string;
}

interface DemoRunResult {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  totalSteps: number;
  passed: number;
  failed: number;
  skipped: number;
  unavailable?: number;
  runDir: string;
  steps: DemoStepResult[];
  truncated?: boolean;
}

interface ApiPayload {
  ok: boolean;
  error?: string;
  result?: DemoRunResult;
}

// ── Helpers ──

function formatStepLabel(name: string): string {
  // "01-navigate-dashboard" → "navigate dashboard"
  const stripped = name.replace(/^\d+-/, '');
  return stripped.replace(/-/g, ' ');
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatRelative(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const delta = Math.max(0, Date.now() - t);
  const seconds = Math.floor(delta / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatSummaryLine(result: DemoRunResult): string {
  const parts: string[] = [`${result.passed}/${result.totalSteps} passed`];
  if (result.failed > 0) {
    parts.push(`${result.failed} failed`);
  }
  const unavailable = result.unavailable ?? 0;
  if (unavailable > 0) {
    parts.push(`${unavailable} unavailable`);
  }
  if (result.skipped > 0) {
    parts.push(`${result.skipped} skipped`);
  }
  return `last run: ${parts.join(' · ')} · ${formatRelative(result.finishedAt)} · ${formatDuration(result.durationMs)}`;
}

function statusTone(status: DemoStepStatus): { dot: string; label: string; pill: string } {
  if (status === 'pass') {
    return { dot: '#22c55e', label: 'PASS', pill: '#22c55e' };
  }
  if (status === 'fail') {
    return { dot: '#ef4444', label: 'FAIL', pill: '#ef4444' };
  }
  if (status === 'unavailable') {
    // Amber — distinct from grey 'skipped' so a missing Tauri command
    // reads as "not run, but not your fault" rather than a cascade.
    return { dot: '#f59e0b', label: 'UNAVAILABLE', pill: '#f59e0b' };
  }
  return { dot: RAMS_INK_QUIET, label: 'SKIPPED', pill: RAMS_INK_QUIET };
}

// ── Component ──

export function DemoRunSection() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DemoRunResult | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const runDemo = useCallback(async () => {
    setBusy(true);
    setError(null);
    // #848 — record an intentional opt-in just before firing. The flag is
    // only ever set here (the explicit Settings button); any future surface
    // that wants to launch the demo must do the same so we never auto-fire
    // and never strand a user on /context-graph by accident.
    try {
      window.localStorage.setItem('o8:demo-sequence:enabled', '1');
    } catch {
      // localStorage unavailable (private mode, SSR) — fine, the API still
      // requires `confirmed: true` in the body so we're covered.
    }
    try {
      const res = await fetch('/api/panel/diagnostics/run-demo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmed: true }),
      });
      const data = await res.json().catch(() => ({})) as ApiPayload;
      if (data.result) {
        setResult(data.result);
      }
      if (!res.ok || data.ok === false) {
        setError(data.error || `HTTP ${res.status}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to run demo sequence');
    } finally {
      setBusy(false);
    }
  }, []);

  const toggle = useCallback((stepName: string) => {
    setExpanded((prev) => ({ ...prev, [stepName]: !prev[stepName] }));
  }, []);

  return (
    <div>
      <GroupHeader>Demo sequence</GroupHeader>

      <div style={{
        borderRadius: 14,
        border: '1px solid var(--t-panel-border)',
        background: 'var(--t-bg-card)',
        overflow: 'hidden',
        paddingLeft: 14,
        paddingRight: 14,
      }}>
      <div style={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 20,
        paddingTop: 14,
        paddingBottom: 16,
        borderBottom: `1px solid ${RAMS_HAIRLINE_SOFT}`,
        flexWrap: 'wrap',
      }}>
        <div style={{ flex: 1, minWidth: 0, maxWidth: 520 }}>
          <div style={{
            fontSize: 14,
            fontWeight: 300,
            color: 'var(--t-text)',
            marginBottom: 4,
            letterSpacing: '-0.01em',
            fontFamily: APP_FONT_STACK,
          }}>
            Run demo sequence
          </div>
          <div style={{
            fontFamily: APP_FONT_STACK,
            fontSize: 13,
            color: 'var(--t-text-secondary)',
            lineHeight: 1.55,
          }}>
            Drives the live webview through dashboard → Orchestrator tab →
            quick action. Captures a screenshot per step and verifies route
            + console-error state. Read-only — never sends, merges, or
            deletes anything.
          </div>
          {result ? (
            <div style={{
              marginTop: 8,
              fontFamily: APP_FONT_STACK,
              fontSize: 12,
              fontWeight: 400,
              letterSpacing: '-0.01em',
              color: RAMS_INK_QUIET,
            }}>
              {formatSummaryLine(result)}
            </div>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => { void runDemo(); }}
          disabled={busy}
          style={runButtonStyle(busy)}
        >
          <PlayIcon />
          <span>{busy ? 'running...' : 'run demo sequence'}</span>
        </button>
      </div>

      {error ? (
        <div style={{
          marginTop: 14,
          paddingTop: 2,
          paddingBottom: 2,
          fontSize: 13,
          color: 'var(--t-text)',
          lineHeight: 1.55,
          fontFamily: APP_FONT_STACK,
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

      {result ? (
        <div style={{ paddingTop: 14, paddingBottom: 4 }}>
          {result.steps.map((step) => (
            <StepRow
              key={step.name}
              step={step}
              open={!!expanded[step.name]}
              onToggle={() => toggle(step.name)}
            />
          ))}
          <RunDirRow runDir={result.runDir} />
        </div>
      ) : null}
      </div>

      <GroupFootnote>
        Screenshots saved locally under{' '}
        <span style={{ fontFamily: MONO_FONT_STACK, fontSize: 11 }}>
          ~/.o8/demo-runs/&lt;timestamp&gt;/
        </span>
        . Last 10 runs retained, older runs auto-pruned.
      </GroupFootnote>
    </div>
  );
}

// ── Sub-views ──

function StepRow({
  step,
  open,
  onToggle,
}: {
  step: DemoStepResult;
  open: boolean;
  onToggle: () => void;
}) {
  const tone = statusTone(step.status);
  const interactive = !!step.message || !!step.screenshotPath;

  return (
    <div>
      <button
        type="button"
        onClick={interactive ? onToggle : undefined}
        disabled={!interactive}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          width: '100%',
          paddingTop: 12,
          paddingBottom: 12,
          borderTop: 'none',
          borderLeft: 'none',
          borderRight: 'none',
          borderBottom: `1px solid ${RAMS_HAIRLINE_SOFT}`,
          background: 'transparent',
          cursor: interactive ? 'pointer' : 'default',
          textAlign: 'left',
          minHeight: 44,
        }}
      >
        <span style={{
          width: 6,
          height: 6,
          borderRadius: 3,
          background: tone.dot,
          flexShrink: 0,
        }} />
        <span style={{
          fontFamily: APP_FONT_STACK,
          fontSize: 11,
          fontWeight: 400,
          color: RAMS_INK_QUIET,
          textTransform: 'uppercase',
          letterSpacing: '0.12em',
          minWidth: 200,
        }}>
          {formatStepLabel(step.name)}
        </span>
        <StatusPill tone={tone} />
        <span style={{
          fontFamily: MONO_FONT_STACK,
          fontSize: 11,
          fontWeight: 400,
          letterSpacing: '0.04em',
          color: 'var(--t-text-secondary)',
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          textAlign: 'right',
        }}>
          {step.status === 'skipped' ? '—' : formatDuration(step.ms)}
        </span>
        {interactive ? <Caret rotated={open} /> : null}
      </button>

      {open && interactive ? (
        <div style={{
          paddingTop: 8,
          paddingBottom: 12,
          paddingLeft: 220,
          borderBottom: `1px solid ${RAMS_HAIRLINE_SOFT}`,
        }}>
          {step.message ? (
            <div style={{
              fontFamily: APP_FONT_STACK,
              fontSize: 12,
              fontWeight: 400,
              color: 'var(--t-text)',
              lineHeight: 1.55,
              letterSpacing: '-0.005em',
              marginBottom: step.screenshotPath ? 6 : 0,
              wordBreak: 'break-word',
            }}>
              {step.message}
            </div>
          ) : null}
          {step.screenshotPath ? (
            <div style={{
              fontFamily: MONO_FONT_STACK,
              fontSize: 11,
              fontWeight: 400,
              letterSpacing: '0.02em',
              color: RAMS_INK_QUIET,
              wordBreak: 'break-all',
            }}>
              {step.screenshotPath}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function RunDirRow({ runDir }: { runDir: string }) {
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
        background: RAMS_INK_QUIET,
        flexShrink: 0,
      }} />
      <span style={{
        fontFamily: APP_FONT_STACK,
        fontSize: 11,
        fontWeight: 400,
        color: RAMS_INK_QUIET,
        textTransform: 'uppercase',
        letterSpacing: '0.12em',
        minWidth: 200,
      }}>
        Run directory
      </span>
      <span style={{
        fontFamily: MONO_FONT_STACK,
        fontSize: 11,
        fontWeight: 400,
        letterSpacing: '0.02em',
        color: 'var(--t-text)',
        flex: 1,
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}>
        {runDir}
      </span>
    </div>
  );
}

function StatusPill({ tone }: { tone: { label: string; pill: string } }) {
  return (
    <span style={{
      fontFamily: APP_FONT_STACK,
      fontSize: 10,
      fontWeight: 400,
      letterSpacing: '0.12em',
      color: tone.pill,
      paddingTop: 2,
      paddingBottom: 2,
      paddingLeft: 6,
      paddingRight: 6,
      border: `1px solid ${tone.pill}`,
      borderRadius: 3,
      flexShrink: 0,
    }}>
      {tone.label}
    </span>
  );
}

function PlayIcon() {
  // Phosphor "play" simplified — single triangle path, raw SVG so it works
  // inside the Tauri webview where lucide / @phosphor-icons/react fail.
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 256 256"
      fill="currentColor"
      style={{ display: 'block', flexShrink: 0 }}
    >
      <path d="M232.4 114.5L88.32 26.51A15.94 15.94 0 0 0 64 39.91v176.18a15.94 15.94 0 0 0 24.32 13.4L232.4 141.5a15.95 15.95 0 0 0 0-27Z" />
    </svg>
  );
}

function Caret({ rotated }: { rotated?: boolean }) {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      style={{
        display: 'block',
        flexShrink: 0,
        color: RAMS_INK_QUIET,
        transition: 'transform 200ms',
        transform: rotated ? 'rotate(180deg)' : 'rotate(0)',
      }}
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

// ── Styles ──

function runButtonStyle(busy: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    minHeight: 32,
    paddingLeft: 14,
    paddingRight: 14,
    borderRadius: 9,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: busy ? RAMS_HAIRLINE_SOFT : 'var(--t-settings-accent-active-border, rgba(29, 78, 216, 0.32))',
    background: busy ? 'transparent' : 'var(--t-settings-accent-active-bg, rgba(29, 78, 216, 0.1))',
    color: busy ? RAMS_INK_QUIET : RAMS_ACCENT,
    fontFamily: APP_FONT_STACK,
    fontSize: 12,
    fontWeight: 400,
    letterSpacing: '-0.01em',
    textTransform: 'capitalize' as const,
    cursor: busy ? 'default' : 'pointer',
    transition: 'background 150ms cubic-bezier(0.22, 1, 0.36, 1), border-color 150ms cubic-bezier(0.22, 1, 0.36, 1)',
    opacity: busy ? 0.6 : 1,
  };
}
