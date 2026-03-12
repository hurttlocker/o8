'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { AgentSummary } from '@/lib/fleet/types';
import { openClawAdapterContract } from '@/lib/runtime/adapter';

type SessionTranscriptEntry = {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  text: string;
  timestamp?: number;
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

function activeRunHint(status: AgentSummary['status']) {
  switch (status) {
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
  const [history, setHistory] = useState<SessionTranscriptEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [actionState, setActionState] = useState<'idle' | 'sending' | 'stopping'>('idle');
  const [actionNote, setActionNote] = useState<string | null>(null);
  const transcriptLimit = compact ? 6 : 10;
  const liveRunVisible = ['running', 'reviewing'].includes(agent.status);

  const loadTranscript = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const response = await fetch(
        `/api/openclaw/history?sessionKey=${encodeURIComponent(agent.sessionKey)}&limit=${transcriptLimit}`,
        {
          cache: 'no-store',
        },
      );
      const payload = await readJson<{ transcript?: SessionTranscriptEntry[] }>(response);
      setHistory(payload.transcript ?? []);
      setHistoryError(null);
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : 'Unable to load transcript');
    } finally {
      setHistoryLoading(false);
    }
  }, [agent.sessionKey, transcriptLimit]);

  useEffect(() => {
    setDraft('');
    setActionNote(null);
    void loadTranscript();
  }, [agent.sessionKey, loadTranscript]);

  async function handleSteerSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const instruction = draft.trim();
    if (!instruction) return;

    setActionState('sending');
    setActionNote(null);

    try {
      await openClawAdapterContract.steer(agent.sessionKey, instruction);
      setDraft('');
      setActionNote('Steer request queued on the live session. External delivery stays off by default.');
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
    setActionState('stopping');
    setActionNote(null);

    try {
      const response = await fetch('/api/openclaw/abort', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sessionKey: agent.sessionKey,
        }),
      });
      const payload = await readJson<{ aborted?: boolean }>(response);
      setActionNote(
        payload.aborted
          ? 'Stop request sent to the active run for this session.'
          : 'No active run was in flight for this session.',
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
            <strong>Explicit runtime control</strong>
          </div>
          <span className="status-pill status-running">chat.send / chat.abort</span>
        </div>
        <p className="muted operator-note">
          This is the first truthful control lane: explicit steer and stop only. Opening the UI still does
          not create a ghost session or auto-deliver anything back to Telegram.
        </p>
        <div className="operator-state-grid">
          <div className="operator-state-card">
            <span>Visible run state</span>
            <strong>{agent.status}</strong>
            <p className="muted">{activeRunHint(agent.status)}</p>
          </div>
          <div className="operator-state-card">
            <span>Abort lane</span>
            <strong>{liveRunVisible ? 'armed' : 'idle-ish'}</strong>
            <p className="muted">Fleet state is heuristic-driven, so abort can still no-op even when the surface looks warm.</p>
          </div>
          <div className="operator-state-card">
            <span>Readable log</span>
            <strong>{historyLoading ? 'loading' : `${history.length} entries`}</strong>
            <p className="muted">Only user/assistant/system text survives here. Hidden thinking and tool blobs stay out.</p>
          </div>
        </div>
        <form className="operator-form" onSubmit={handleSteerSubmit}>
          <textarea
            className="operator-textarea"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={compact ? 3 : 4}
            placeholder={`Steer ${agent.name} without creating a new session…`}
          />
          <div className="operator-actions queue-toolbar">
            <button className="button-primary" type="submit" disabled={actionState !== 'idle' || !draft.trim()}>
              {actionState === 'sending' ? 'Steering…' : 'Steer session'}
            </button>
            <button type="button" onClick={handleStop} disabled={actionState !== 'idle'}>
              {actionState === 'stopping' ? 'Stopping…' : 'Stop active run'}
            </button>
            <button type="button" onClick={() => void loadTranscript()} disabled={historyLoading || actionState !== 'idle'}>
              {historyLoading ? 'Refreshing…' : 'Refresh log'}
            </button>
          </div>
        </form>
        {actionNote ? <p className="muted operator-note">{actionNote}</p> : null}
      </div>

      <div className="inset-card inspector-block tool-shell terminal-shell">
        <div className="row space-between compact-row operator-header-row">
          <div>
            <span>Session log</span>
            <strong>Sanitized transcript</strong>
          </div>
          <span className="status-pill status-healthy">history</span>
        </div>
        <p className="muted operator-note">
          Pulled from OpenClaw <span className="mono">chat.history</span>. Hidden thinking and raw tool internals
          are intentionally omitted here.
        </p>
        {historyError ? <p className="muted operator-note">{historyError}</p> : null}
        {history.length ? (
          <div className="transcript-list terminal-stack">
            {history.map((entry) => (
              <div key={entry.id} className="transcript-entry terminal-entry">
                <div className="row space-between compact-row">
                  <strong>{roleLabel(entry.role)}</strong>
                  <span className="muted mono">{entry.timestampLabel ?? 'now'}</span>
                </div>
                <p>{entry.text}</p>
              </div>
            ))}
          </div>
        ) : historyLoading ? (
          <p className="muted operator-note">Loading transcript…</p>
        ) : (
          <p className="muted operator-note">
            No visible transcript text is available for this session yet. That usually means the freshest activity
            was tool-heavy/internal or compaction trimmed the readable turns, not that the bridge is broken.
          </p>
        )}
      </div>
    </>
  );
}
