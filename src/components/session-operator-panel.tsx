'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { AgentSummary } from '@/lib/fleet/types';

type SessionTranscriptEntry = {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  text: string;
  timestamp?: number;
  timestampLabel?: string;
};

type RuntimeLogEntry = {
  id: string;
  label: string;
  text: string;
  timestampLabel?: string;
};

function roleLabel(role: SessionTranscriptEntry['role']) {
  switch (role) {
    case 'assistant':
      return 'Assistant';
    case 'user':
      return 'User';
    case 'system':
      return 'System';
    case 'tool':
      return 'Tool';
    default:
      return 'Message';
  }
}

async function readJson<T>(response: Response) {
  const payload = (await response.json().catch(() => null)) as T | { error?: string } | null;
  if (!response.ok) {
    const errorMessage =
      payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
        ? payload.error
        : `HTTP ${response.status}`;
    throw new Error(errorMessage);
  }

  return payload as T;
}

function activeRunHint(agent: AgentSummary) {
  if (agent.runtime !== 'openclaw') {
    if (agent.runtimeSurface?.ownership === 'owned') {
      return agent.status === 'running'
        ? 'This IDE-owned Codex run is active right now, so interrupt is the truthful control. The next input becomes available only after the run settles.'
        : 'This IDE-owned Codex session is between runs. The truthful next step is to resume it with the next input, not inject live keystrokes.';
    }

    return 'This surface is currently read-only. The first truthful lane is attach/read-tail; input and interrupt stay disabled until we can prove an owned-session seam.';
  }

  switch (agent.status) {
    case 'running':
      return 'Live surface looks active right now. Steer and abort should both behave like real operator actions.';
    case 'reviewing':
      return 'Surface looks warm/recent. Abort may still help, but it can also no-op if the run already settled.';
    case 'waiting':
      return 'Surface is visible but not clearly hot. Steer is safe; abort is mostly a guardrail.';
    case 'blocked':
      return 'Surface is blocked. Steer can supply correction context; abort is mostly cleanup.';
    case 'idle':
    case 'failed':
    default:
      return 'Surface looks idle. Steer will queue a new turn on the existing session; abort likely does nothing.';
  }
}

export function SessionOperatorPanel({
  agent,
  compact = false,
}: {
  agent: AgentSummary;
  compact?: boolean;
}) {
  const [draft, setDraft] = useState('');
  const [history, setHistory] = useState<RuntimeLogEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [actionState, setActionState] = useState<'idle' | 'sending' | 'stopping'>('idle');
  const [actionNote, setActionNote] = useState<string | null>(null);
  const transcriptLimit = compact ? 6 : 10;
  const liveRunVisible = ['running', 'reviewing'].includes(agent.status);
  const runtimeSurface = agent.runtimeSurface;
  const isOpenClaw = agent.runtime === 'openclaw';
  const isOwnedCodex = agent.runtime === 'codex' && runtimeSurface?.ownership === 'owned';
  const hasActionLane = isOpenClaw || isOwnedCodex;
  const canSendInput = Boolean(runtimeSurface?.capabilities.sendInput);
  const canInterrupt = Boolean(runtimeSurface?.capabilities.interrupt);

  const loadTranscript = useCallback(async () => {
    setHistoryLoading(true);
    try {
      if (isOpenClaw) {
        const response = await fetch(
          `/api/openclaw/history?sessionKey=${encodeURIComponent(agent.sessionKey)}&limit=${transcriptLimit}`,
          {
            cache: 'no-store',
          },
        );
        const payload = await readJson<{ transcript?: SessionTranscriptEntry[] }>(response);
        setHistory(
          (payload.transcript ?? []).map((entry) => ({
            id: entry.id,
            label: roleLabel(entry.role),
            text: entry.text,
            timestampLabel: entry.timestampLabel,
          })),
        );
      } else if (runtimeSurface?.capabilities.readTail) {
        const response = await fetch(`/api/runtime/tail?surfaceId=${encodeURIComponent(runtimeSurface.id)}`, {
          cache: 'no-store',
        });
        const payload = await readJson<{ entries?: RuntimeLogEntry[] }>(response);
        setHistory(payload.entries ?? []);
      } else {
        setHistory([]);
      }
      setHistoryError(null);
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : 'Unable to load runtime history');
    } finally {
      setHistoryLoading(false);
    }
  }, [agent.sessionKey, isOpenClaw, runtimeSurface, transcriptLimit]);

  useEffect(() => {
    setDraft('');
    setActionNote(null);
    void loadTranscript();
  }, [agent.sessionKey, loadTranscript]);

  async function handleSteerSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const instruction = draft.trim();
    if (!instruction || !canSendInput) return;

    setActionState('sending');
    setActionNote(null);

    try {
      const response = await fetch('/api/runtime/action', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'steer',
          surfaceId: runtimeSurface?.id ?? agent.sessionKey,
          message: instruction,
        }),
      });
      const result = await readJson<{ note: string }>(response);
      setDraft('');
      setActionNote(result.note ?? 'Steer request queued on the live session. External delivery stays off by default.');
      await loadTranscript();
      window.setTimeout(() => {
        void loadTranscript();
      }, 1200);
    } catch (error) {
      setActionNote(error instanceof Error ? error.message : 'Unable to steer the session');
    } finally {
      setActionState('idle');
    }
  }

  async function handleStop() {
    if (!canInterrupt) return;

    setActionState('stopping');
    setActionNote(null);

    try {
      const response = await fetch('/api/runtime/action', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'stop',
          surfaceId: runtimeSurface?.id ?? agent.sessionKey,
        }),
      });
      const payload = await readJson<{ aborted?: boolean; note?: string }>(response);
      setActionNote(
        payload.note
          ?? (payload.aborted
            ? 'Stop request sent to the active run for this session.'
            : 'No active run was in flight for this session.'),
      );
      await loadTranscript();
    } catch (error) {
      setActionNote(error instanceof Error ? error.message : 'Unable to stop the session');
    } finally {
      setActionState('idle');
    }
  }

  return (
    <>
      <div className="inset-card inspector-block tool-shell">
        <div className="row space-between compact-row operator-header-row">
          <div>
            <span>Operator actions</span>
            <strong>
              {isOpenClaw
                ? 'Explicit runtime control'
                : isOwnedCodex
                  ? 'Owned Codex control'
                  : 'Read-only runtime watch'}
            </strong>
          </div>
          <span className={`status-pill ${hasActionLane ? 'status-running' : 'status-warning'}`}>
            {isOpenClaw ? 'chat.send / chat.abort' : isOwnedCodex ? 'exec resume / interrupt' : 'attach / read-tail'}
          </span>
        </div>
        <p className="muted operator-note">
          {isOpenClaw
            ? 'This is the first truthful control lane: explicit steer and stop only. Opening the UI still does not create a ghost session or auto-deliver anything back to Telegram.'
            : isOwnedCodex
              ? `${runtimeSurface?.sourceLabel ?? 'Runtime surface'} was launched by Cortex IDE. The truthful mutable lane is: launch → resume between runs → interrupt while active.`
              : `${runtimeSurface?.sourceLabel ?? 'Runtime surface'} is visible inside the same product, but mutation stays disabled until we can prove an owned-session seam.`}
        </p>
        <div className="operator-state-grid">
          <div className="operator-state-card">
            <span>Visible run state</span>
            <strong>{agent.status}</strong>
            <p className="muted">{activeRunHint(agent)}</p>
          </div>
          <div className="operator-state-card">
            <span>{isOpenClaw ? 'Abort lane' : isOwnedCodex ? 'Resume / interrupt lane' : 'Attach lane'}</span>
            <strong>
              {isOpenClaw
                ? (liveRunVisible ? 'armed' : 'idle-ish')
                : isOwnedCodex
                  ? (canInterrupt ? 'interruptable' : canSendInput ? 'ready for resume' : 'warming up')
                  : runtimeSurface?.capabilities.attach ? 'readable' : 'unavailable'}
            </strong>
            <p className="muted">
              {isOpenClaw
                ? 'Fleet state is heuristic-driven, so abort can still no-op even when the surface looks warm.'
                : isOwnedCodex
                  ? 'Owned Codex sessions can accept the next input only between runs. While a run is active, interrupt is the truthful control.'
                  : 'This is a truthful first pass: runtime watch is available, but only IDE-owned surfaces may eventually become mutable.'}
            </p>
          </div>
          <div className="operator-state-card">
            <span>Readable log</span>
            <strong>{historyLoading ? 'loading' : `${history.length} entries`}</strong>
            <p className="muted">
              {isOpenClaw
                ? 'Only user/assistant/system text survives here. Hidden thinking and tool blobs stay out.'
                : isOwnedCodex
                  ? `Recovered from ${runtimeSurface?.tailSourceLabel ?? 'owned runtime logs'} and summarized across launch/resume turns.`
                  : `Recovered from ${runtimeSurface?.tailSourceLabel ?? 'runtime metadata'} and summarized into a bounded readable tail.`}
            </p>
          </div>
        </div>
        {hasActionLane ? (
          <form className="operator-form" onSubmit={handleSteerSubmit}>
            <textarea
              className="operator-textarea"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              rows={compact ? 3 : 4}
              placeholder={isOpenClaw
                ? `Steer ${agent.name} without creating a new session…`
                : `Send the next input to ${agent.name} by resuming the owned Codex session…`}
            />
            <div className="operator-actions queue-toolbar">
              <button className="button-primary" type="submit" disabled={actionState !== 'idle' || !draft.trim() || !canSendInput}>
                {actionState === 'sending' ? (isOpenClaw ? 'Steering…' : 'Resuming…') : (isOpenClaw ? 'Steer session' : 'Send next input')}
              </button>
              <button type="button" onClick={handleStop} disabled={actionState !== 'idle' || !canInterrupt}>
                {actionState === 'stopping' ? (isOpenClaw ? 'Stopping…' : 'Interrupting…') : (isOpenClaw ? 'Stop active run' : 'Interrupt run')}
              </button>
              <button type="button" onClick={() => void loadTranscript()} disabled={historyLoading || actionState !== 'idle'}>
                {historyLoading ? 'Refreshing…' : 'Refresh log'}
              </button>
            </div>
          </form>
        ) : (
          <div className="operator-actions queue-toolbar">
            <button type="button" onClick={() => void loadTranscript()} disabled={historyLoading}>
              {historyLoading ? 'Refreshing…' : 'Refresh tail'}
            </button>
            <button type="button" disabled>
              Send input (owned only)
            </button>
            <button type="button" disabled>
              Interrupt (owned only)
            </button>
          </div>
        )}
        {actionNote ? <p className="muted operator-note">{actionNote}</p> : null}
      </div>

      <div className="inset-card inspector-block tool-shell terminal-shell">
        <div className="row space-between compact-row operator-header-row">
          <div>
            <span>{isOpenClaw ? 'Session log' : 'Runtime tail'}</span>
            <strong>{isOpenClaw ? 'Sanitized transcript' : 'Readable Codex tail'}</strong>
          </div>
          <span className="status-pill status-healthy">{isOpenClaw ? 'history' : 'tail'}</span>
        </div>
        <p className="muted operator-note">
          {isOpenClaw ? (
            <>
              Pulled from OpenClaw <span className="mono">chat.history</span>. Hidden thinking and raw tool internals are intentionally omitted here.
            </>
          ) : isOwnedCodex ? (
            <>
              Recovered from <span className="mono">IDE-owned Codex exec/resume JSON logs</span> and summarized across turns.
            </>
          ) : (
            <>
              Recovered from <span className="mono">~/.codex/sessions/*.jsonl</span> and summarized into a bounded operator-readable watch surface.
            </>
          )}
        </p>
        {historyError ? <p className="muted operator-note">{historyError}</p> : null}
        {history.length ? (
          <div className="transcript-list terminal-stack">
            {history.map((entry) => (
              <div key={entry.id} className="transcript-entry terminal-entry">
                <div className="row space-between compact-row">
                  <strong>{entry.label}</strong>
                  <span className="muted mono">{entry.timestampLabel ?? 'now'}</span>
                </div>
                <p>{entry.text}</p>
              </div>
            ))}
          </div>
        ) : historyLoading ? (
          <p className="muted operator-note">{isOpenClaw ? 'Loading transcript…' : 'Loading runtime tail…'}</p>
        ) : (
          <p className="muted operator-note">
            {isOpenClaw
              ? 'No visible transcript text is available for this session yet. That usually means the freshest activity was tool-heavy/internal or compaction trimmed the readable turns, not that the bridge is broken.'
              : isOwnedCodex
                ? 'No readable owned-session entries were recovered yet. That usually means the launch/resume run has not emitted completed JSON items yet, not that the registry is broken.'
                : 'No readable tail entries were recovered yet. That usually means the session has not emitted recent readable events, not that discovery failed.'}
          </p>
        )}
      </div>
    </>
  );
}
