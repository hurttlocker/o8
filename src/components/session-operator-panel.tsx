'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { AgentSummary, RuntimeReviewPacket } from '@/lib/fleet/types';

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

type OwnedRuntimeTailGroup = {
  id: string;
  title: string;
  mode: 'launch' | 'resume';
  outcome: 'running' | 'finished' | 'interrupted' | 'failed';
  prompt: string;
  startedAtLabel?: string;
  finishedAtLabel?: string;
  summary: string;
  entries: RuntimeLogEntry[];
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

function lifecycleLabel(agent: AgentSummary) {
  const lifecycle = agent.runtimeSurface?.lifecycle;
  if (!lifecycle) return agent.status;

  if (lifecycle.availability === 'running') return 'running';
  if (lifecycle.availability === 'awaiting-thread') return 'awaiting thread';
  if (lifecycle.availability === 'ready-for-resume') return 'ready for resume';
  return agent.status;
}

function lastOutcomeLabel(agent: AgentSummary) {
  return agent.runtimeSurface?.lifecycle?.lastOutcome ?? 'none yet';
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
  onRuntimeRefresh,
}: {
  agent: AgentSummary;
  compact?: boolean;
  onRuntimeRefresh?: (preferredId?: string) => Promise<unknown> | unknown;
}) {
  const [draft, setDraft] = useState('');
  const [history, setHistory] = useState<RuntimeLogEntry[]>([]);
  const [ownedGroups, setOwnedGroups] = useState<OwnedRuntimeTailGroup[]>([]);
  const [reviewPacket, setReviewPacket] = useState<RuntimeReviewPacket | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
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
  const ownedLifecycleLabel = lifecycleLabel(agent);
  const ownedLastOutcomeLabel = lastOutcomeLabel(agent);

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
        setOwnedGroups([]);
      } else if (runtimeSurface?.capabilities.readTail) {
        const response = await fetch(`/api/runtime/tail?surfaceId=${encodeURIComponent(runtimeSurface.id)}`, {
          cache: 'no-store',
        });
        const payload = await readJson<{ entries?: RuntimeLogEntry[]; groups?: OwnedRuntimeTailGroup[] }>(response);
        setHistory(payload.entries ?? []);
        setOwnedGroups(payload.groups ?? []);
      } else {
        setHistory([]);
        setOwnedGroups([]);
      }
      setHistoryError(null);
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : 'Unable to load runtime history');
    } finally {
      setHistoryLoading(false);
    }
  }, [agent.sessionKey, isOpenClaw, runtimeSurface, transcriptLimit]);

  const loadReviewPacket = useCallback(async () => {
    if (!isOwnedCodex || !runtimeSurface?.id) {
      setReviewPacket(null);
      setReviewError(null);
      return;
    }

    setReviewLoading(true);
    try {
      const response = await fetch(`/api/runtime/review?surfaceId=${encodeURIComponent(runtimeSurface.id)}`, {
        cache: 'no-store',
      });
      const payload = await readJson<RuntimeReviewPacket>(response);
      setReviewPacket(payload);
      setReviewError(null);
    } catch (error) {
      setReviewError(error instanceof Error ? error.message : 'Unable to load runtime review packet');
    } finally {
      setReviewLoading(false);
    }
  }, [isOwnedCodex, runtimeSurface]);

  useEffect(() => {
    setDraft('');
    setActionNote(null);
    void loadTranscript();
    void loadReviewPacket();
  }, [agent.sessionKey, loadTranscript, loadReviewPacket]);

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
      await loadReviewPacket();
      await onRuntimeRefresh?.(agent.id);
      window.setTimeout(() => {
        void loadTranscript();
        void loadReviewPacket();
        void onRuntimeRefresh?.(agent.id);
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
      await loadReviewPacket();
      await onRuntimeRefresh?.(agent.id);
      window.setTimeout(() => {
        void loadTranscript();
        void loadReviewPacket();
        void onRuntimeRefresh?.(agent.id);
      }, 1200);
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
            <span>{isOwnedCodex ? 'Lifecycle state' : 'Visible run state'}</span>
            <strong>{isOwnedCodex ? ownedLifecycleLabel : agent.status}</strong>
            <p className="muted">{activeRunHint(agent)}</p>
          </div>
          <div className="operator-state-card">
            <span>{isOpenClaw ? 'Abort lane' : isOwnedCodex ? 'Last outcome / action lane' : 'Attach lane'}</span>
            <strong>
              {isOpenClaw
                ? (liveRunVisible ? 'armed' : 'idle-ish')
                : isOwnedCodex
                  ? `${ownedLastOutcomeLabel} • ${canInterrupt ? 'interruptable' : canSendInput ? 'ready' : 'warming'}`
                  : runtimeSurface?.capabilities.attach ? 'readable' : 'unavailable'}
            </strong>
            <p className="muted">
              {isOpenClaw
                ? 'Fleet state is heuristic-driven, so abort can still no-op even when the surface looks warm.'
                : isOwnedCodex
                  ? 'Owned Codex now preserves the last outcome separately from current availability, so interrupted / finished / failed runs do not collapse into the same vague state.'
                  : 'This is a truthful first pass: runtime watch is available, but only IDE-owned surfaces may eventually become mutable.'}
            </p>
          </div>
          <div className="operator-state-card">
            <span>Readable log</span>
            <strong>{historyLoading ? 'loading' : isOwnedCodex ? `${ownedGroups.length || history.length} grouped turns` : `${history.length} entries`}</strong>
            <p className="muted">
              {isOpenClaw
                ? 'Only user/assistant/system text survives here. Hidden thinking and tool blobs stay out.'
                : isOwnedCodex
                  ? `Recovered from ${runtimeSurface?.tailSourceLabel ?? 'owned runtime logs'} and grouped into launch/resume turns with explicit outcomes.`
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

      {isOwnedCodex ? (
        <div className="inset-card inspector-block tool-shell">
          <div className="row space-between compact-row operator-header-row">
            <div>
              <span>Review packet</span>
              <strong>Decision-ready evidence</strong>
            </div>
            <span className={`status-pill ${reviewPacket?.dirty ? 'status-warning' : 'status-healthy'}`}>
              {reviewLoading ? 'loading' : reviewPacket?.dirty ? `${reviewPacket.changedFiles.length} review files` : 'clean repo'}
            </span>
          </div>
          <p className="muted operator-note">
            The first packet is intentionally honest: latest run evidence + current repo delta. It is useful now, even though per-run file attribution is not yet isolated when multiple sessions touch the same repo.
          </p>
          {reviewError ? <p className="muted operator-note">{reviewError}</p> : null}
          {reviewPacket ? (
            <>
              <div className="operator-state-grid">
                <div className="operator-state-card">
                  <span>Repo</span>
                  <strong>{reviewPacket.repoSlug ?? reviewPacket.title}</strong>
                  <p className="muted mono">{reviewPacket.repoPath}</p>
                </div>
                <div className="operator-state-card">
                  <span>Branch / head</span>
                  <strong>{reviewPacket.branch ?? 'detached'}</strong>
                  <p className="muted mono">{reviewPacket.head ?? 'unknown head'}</p>
                </div>
                <div className="operator-state-card">
                  <span>Next actions</span>
                  <strong>{reviewPacket.nextActions[0] ?? 'Review evidence'}</strong>
                  <p className="muted">{reviewPacket.nextActions.slice(1).join(' • ') || 'No extra guidance yet.'}</p>
                </div>
              </div>

              <div className="workflow-warning-list">
                <p className="muted workflow-note">{reviewPacket.summary}</p>
                {reviewPacket.notes.map((note) => (
                  <p key={note} className="muted workflow-note">{note}</p>
                ))}
              </div>

              {reviewPacket.lastRun ? (
                <div className="workflow-file-item top-gap">
                  <div className="row space-between compact-row">
                    <strong>{`${reviewPacket.lastRun.mode === 'launch' ? 'Launch' : 'Resume'} run • ${reviewPacket.lastRun.outcome}`}</strong>
                    <span className="muted mono">{reviewPacket.lastRun.finishedAtLabel ?? reviewPacket.lastRun.startedAtLabel ?? 'now'}</span>
                  </div>
                  <p className="muted">{reviewPacket.lastRun.assistantSummary ?? reviewPacket.lastRun.prompt}</p>
                  {reviewPacket.lastRun.commands.length ? (
                    <div className="workflow-file-list">
                      {reviewPacket.lastRun.commands.slice(0, 4).map((command) => (
                        <div key={command.id} className="workflow-file-item">
                          <div className="row space-between compact-row">
                            <strong className="mono">{command.command}</strong>
                            <span className={`status-pill status-${command.status === 'completed' ? 'healthy' : command.status === 'running' ? 'running' : command.status === 'interrupted' ? 'warning' : 'critical'}`}>
                              {command.status}{command.exitCode != null ? ` • exit ${command.exitCode}` : ''}
                            </span>
                          </div>
                          <p className="muted mono">{command.outputPreview ?? 'No aggregated command output was captured for this step.'}</p>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="muted workflow-note">No command evidence was captured for the latest owned run.</p>
                  )}
                </div>
              ) : null}

              <div className="workflow-grid top-gap">
                <div className="inset-card inspector-block tool-shell">
                  <div className="row space-between compact-row operator-header-row">
                    <div>
                      <span>Current repo delta</span>
                      <strong>{reviewPacket.dirty ? 'Review this result now' : 'No local file delta'}</strong>
                    </div>
                    <span className={`status-pill ${reviewPacket.dirty ? 'status-reviewing' : 'status-healthy'}`}>
                      {reviewPacket.changedFiles.length} files
                    </span>
                  </div>
                  <p className="muted workflow-note mono">{reviewPacket.diffStat}</p>
                  {reviewPacket.changedFiles.length ? (
                    <div className="workflow-file-list">
                      {reviewPacket.changedFiles.slice(0, 8).map((file) => (
                        <div key={`${file.status}:${file.path}`} className="workflow-file-item">
                          <div className="row space-between compact-row">
                            <strong className="mono">{file.path}</strong>
                            <span className="status-pill status-reviewing">{file.status}</span>
                          </div>
                          <p className="muted mono">+{file.additions ?? '—'} / -{file.deletions ?? '—'}</p>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
                <div className="inset-card inspector-block tool-shell">
                  <div className="row space-between compact-row operator-header-row">
                    <div>
                      <span>Recent commits</span>
                      <strong>Repo truth</strong>
                    </div>
                    <span className="status-pill status-healthy">{reviewPacket.recentCommits.length}</span>
                  </div>
                  {reviewPacket.recentCommits.length ? (
                    <div className="workflow-file-list">
                      {reviewPacket.recentCommits.map((commit) => (
                        <div key={commit} className="workflow-file-item">
                          <p className="muted mono">{commit}</p>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="muted workflow-note">Recent commit history is unavailable for this repo.</p>
                  )}
                </div>
              </div>
            </>
          ) : reviewLoading ? (
            <p className="muted operator-note">Loading review packet…</p>
          ) : (
            <p className="muted operator-note">No review packet is available for this owned surface yet.</p>
          )}
        </div>
      ) : null}

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
        {isOwnedCodex && ownedGroups.length ? (
          <div className="transcript-list terminal-stack">
            {ownedGroups.map((group) => (
              <div key={group.id} className="transcript-entry terminal-entry">
                <div className="row space-between compact-row">
                  <strong>{group.title}</strong>
                  <span className="muted mono">{group.finishedAtLabel ?? group.startedAtLabel ?? 'now'}</span>
                </div>
                <p>{group.summary}</p>
                <div className="operator-state-grid">
                  <div className="operator-state-card">
                    <span>Turn type</span>
                    <strong>{group.mode}</strong>
                    <p className="muted">{group.startedAtLabel ? `Started ${group.startedAtLabel}` : 'Start time unavailable'}</p>
                  </div>
                  <div className="operator-state-card">
                    <span>Outcome</span>
                    <strong>{group.outcome}</strong>
                    <p className="muted">{group.finishedAtLabel ? `Finished ${group.finishedAtLabel}` : 'Still in flight or waiting for completion.'}</p>
                  </div>
                  <div className="operator-state-card">
                    <span>Prompt</span>
                    <strong>{group.mode === 'launch' ? 'launch' : 'resume'}</strong>
                    <p className="muted">{group.prompt}</p>
                  </div>
                </div>
                <div className="transcript-list terminal-stack">
                  {group.entries.map((entry) => (
                    <div key={entry.id} className="transcript-entry terminal-entry">
                      <div className="row space-between compact-row">
                        <strong>{entry.label}</strong>
                        <span className="muted mono">{entry.timestampLabel ?? 'now'}</span>
                      </div>
                      <p>{entry.text}</p>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : history.length ? (
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
