'use client';

/**
 * OrchestratorRunStrip — a slim "watch live" strip at the top of the
 * orchestrator chat. When agents (or the operator) have live `o8 run`
 * sessions, each surfaces here as a chip; clicking it fires
 * `o8:open-agent-terminal` so the live read-only terminal opens in the bottom
 * panel — the operator watches the raw stdout without leaving the chat.
 *
 * Hidden (zero chrome) when no run is active. Polls /api/panel/managed-runs
 * (cheap, in-process) and refreshes on agent-lifecycle events.
 */

import { useEffect, useState } from 'react';
import { Terminal as TerminalIcon } from 'iconoir-react';

interface ManagedRun {
  id: string;
  session: string;
  command: string;
  status: 'running' | 'finished' | 'gone';
}

function shortLabel(command: string): string {
  const trimmed = command.trim();
  return trimmed.length > 40 ? `${trimmed.slice(0, 39)}…` : trimmed;
}

export function OrchestratorRunStrip({ active }: { active: boolean }) {
  const [runs, setRuns] = useState<ManagedRun[]>([]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const fetchRuns = () => {
      fetch('/api/panel/managed-runs')
        .then((r) => r.json())
        .then((data: { runs?: ManagedRun[] }) => {
          if (cancelled) return;
          setRuns((data.runs ?? []).filter((r) => r.status === 'running'));
        })
        .catch(() => {});
    };
    fetchRuns();
    const handler = () => fetchRuns();
    window.addEventListener('o8:agent-lifecycle', handler);
    const timer = setInterval(fetchRuns, 8_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener('o8:agent-lifecycle', handler);
    };
  }, [active]);

  if (runs.length === 0) return null;

  const watch = (session: string) => {
    window.dispatchEvent(new CustomEvent('o8:open-agent-terminal', { detail: { session } }));
  };

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
        paddingTop: 7,
        paddingRight: 14,
        paddingBottom: 7,
        paddingLeft: 14,
        borderBottomWidth: '0.5px',
        borderBottomStyle: 'solid',
        borderBottomColor: 'var(--t-divider-subtle)',
        background: 'var(--t-chat-surface-bg, #ffffff)',
        flexShrink: 0,
      }}
    >
      <span
        style={{
          fontSize: 9,
          fontWeight: 600,
          letterSpacing: '0.5px',
          textTransform: 'uppercase',
          color: 'var(--t-text-faint)',
          flexShrink: 0,
        }}
      >
        Running
      </span>
      {runs.map((run) => (
        <button
          key={run.session}
          type="button"
          onClick={() => watch(run.session)}
          title={`Watch the live terminal: ${run.command}`}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            height: 24,
            paddingTop: 0,
            paddingRight: 9,
            paddingBottom: 0,
            paddingLeft: 8,
            borderRadius: 7,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'var(--t-accent-border)',
            background: 'var(--t-accent-soft)',
            color: 'var(--t-accent)',
            cursor: 'pointer',
            fontSize: 11.5,
            fontWeight: 500,
            letterSpacing: '-0.005em',
            fontFamily: 'var(--font-sans-system)',
            maxWidth: 320,
            flexShrink: 0,
            transition: 'background 160ms cubic-bezier(0.22, 1, 0.36, 1)',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--t-accent-soft-strong, var(--t-accent-soft))'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--t-accent-soft)'; }}
        >
          <TerminalIcon width={12} height={12} color="var(--t-accent)" strokeWidth={2} style={{ flexShrink: 0 }} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {shortLabel(run.command)}
          </span>
        </button>
      ))}
    </div>
  );
}
