'use client';

import { memo, useCallback, useEffect, useRef, useState, type Dispatch, type FormEvent, type RefObject, type SetStateAction } from 'react';
import type { BrowserSurfaceSummary } from '@/lib/browser/types';
import type { AgentSummary, RuntimeReviewPacket } from '@/lib/fleet/types';
import type { RealtimeMutationRecord } from '@/lib/realtime/types';

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

type ReviewFileDetail = {
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';
  additions?: number | null;
  deletions?: number | null;
  originalPath?: string;
  currentPath?: string;
  note: string;
  preview: string;
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

function reviewDispositionTone(disposition: RuntimeReviewPacket['reviewDisposition']) {
  return disposition === 'resolved' ? 'healthy' : 'warning';
}

function browserStatusTone(status: BrowserSurfaceSummary['status']) {
  switch (status) {
    case 'active':
      return 'running';
    case 'idle':
      return 'warning';
    case 'unavailable':
    default:
      return 'critical';
  }
}

function browserActionLabel(browserSurface: BrowserSurfaceSummary) {
  return browserSurface.lastAction ?? 'browser observed';
}

function browserTimestampLabel(timestamp?: number) {
  if (!timestamp) return 'timestamp unavailable';
  return new Date(timestamp).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });
}

function buildCorrectionDraft(packet: RuntimeReviewPacket) {
  const lines = [
    'Continue from the current owned session state. Use the evidence below and make the smallest correct next move.',
  ];

  if (packet.lastRun) {
    lines.push(`Last run: ${packet.lastRun.mode} • ${packet.lastRun.outcome}.`);
  }
  if (packet.lastRun?.assistantSummary) {
    lines.push(`Assistant summary: ${packet.lastRun.assistantSummary}`);
  }
  if (packet.lastRun?.commands[0]) {
    lines.push(`Command evidence: ${packet.lastRun.commands[0].command} (${packet.lastRun.commands[0].status}${packet.lastRun.commands[0].exitCode != null ? `, exit ${packet.lastRun.commands[0].exitCode}` : ''}).`);
  }
  if (packet.changedFiles.length) {
    const files = packet.changedFiles.slice(0, 5).map((file) => file.path).join(', ');
    lines.push(`Current repo delta: ${files}.`);
  } else {
    lines.push('Current repo delta is clean, so prefer a bounded follow-up or verification step over broad rewrites.');
  }

  lines.push('Inspect the current diff context, correct the smallest failing or incomplete piece, and then summarize exactly what changed and what still needs review.');
  return lines.join('\n');
}

const OperatorActionsPanel = memo(function OperatorActionsPanel({
  agent,
  compact,
  runtimeSurface,
  isOpenClaw,
  isOwnedCodex,
  hasActionLane,
  liveRunVisible,
  canSendInput,
  canInterrupt,
  ownedLifecycleLabel,
  ownedLastOutcomeLabel,
  historyLoading,
  historyLength,
  ownedGroupsLength,
  draft,
  setDraft,
  draftRef,
  actionState,
  actionNote,
  onSubmit,
  onStop,
  onRefreshTranscript,
}: {
  agent: AgentSummary;
  compact: boolean;
  runtimeSurface: AgentSummary['runtimeSurface'];
  isOpenClaw: boolean;
  isOwnedCodex: boolean;
  hasActionLane: boolean;
  liveRunVisible: boolean;
  canSendInput: boolean;
  canInterrupt: boolean;
  ownedLifecycleLabel: string;
  ownedLastOutcomeLabel: string;
  historyLoading: boolean;
  historyLength: number;
  ownedGroupsLength: number;
  draft: string;
  setDraft: Dispatch<SetStateAction<string>>;
  draftRef: RefObject<HTMLTextAreaElement | null>;
  actionState: 'idle' | 'sending' | 'stopping' | 'reviewing';
  actionNote: string | null;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onStop: () => void;
  onRefreshTranscript: () => void;
}) {
  return (
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
          <strong>{historyLoading ? 'loading' : isOwnedCodex ? `${ownedGroupsLength || historyLength} grouped turns` : `${historyLength} entries`}</strong>
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
        <form className="operator-form" onSubmit={onSubmit}>
          <textarea
            ref={draftRef}
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
            <button type="button" onClick={onStop} disabled={actionState !== 'idle' || !canInterrupt}>
              {actionState === 'stopping' ? (isOpenClaw ? 'Stopping…' : 'Interrupting…') : (isOpenClaw ? 'Stop active run' : 'Interrupt run')}
            </button>
            <button type="button" onClick={onRefreshTranscript} disabled={historyLoading || actionState !== 'idle'}>
              {historyLoading ? 'Refreshing…' : 'Refresh log'}
            </button>
          </div>
        </form>
      ) : (
        <div className="operator-actions queue-toolbar">
          <button type="button" onClick={onRefreshTranscript} disabled={historyLoading}>
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
  );
});

const RuntimeTailPanel = memo(function RuntimeTailPanel({
  isOpenClaw,
  isOwnedCodex,
  historyLoading,
  historyError,
  history,
  ownedGroups,
}: {
  isOpenClaw: boolean;
  isOwnedCodex: boolean;
  historyLoading: boolean;
  historyError: string | null;
  history: RuntimeLogEntry[];
  ownedGroups: OwnedRuntimeTailGroup[];
}) {
  return (
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
  );
});

const OwnedReviewPanel = memo(function OwnedReviewPanel({
  reviewPacket,
  reviewLoading,
  reviewError,
  reviewFile,
  reviewFileLoading,
  reviewFileError,
  actionState,
  canSendInput,
  onOpenReviewFile,
  onLoadCorrectionDraft,
  onToggleDisposition,
}: {
  reviewPacket: RuntimeReviewPacket | null;
  reviewLoading: boolean;
  reviewError: string | null;
  reviewFile: ReviewFileDetail | null;
  reviewFileLoading: boolean;
  reviewFileError: string | null;
  actionState: 'idle' | 'sending' | 'stopping' | 'reviewing';
  canSendInput: boolean;
  onOpenReviewFile: (reviewPath: string) => void;
  onLoadCorrectionDraft: () => void;
  onToggleDisposition: () => void;
}) {
  return (
    <div className="inset-card inspector-block tool-shell">
      <div className="row space-between compact-row operator-header-row">
        <div>
          <span>Review packet</span>
          <strong>Decision-ready evidence</strong>
        </div>
        <span className={`status-pill status-${reviewDispositionTone(reviewPacket?.reviewDisposition ?? 'watching')}`}>
          {reviewLoading
            ? 'loading'
            : reviewPacket
              ? `${reviewPacket.reviewDisposition} • ${reviewPacket.dirty ? `${reviewPacket.changedFiles.length} review files` : 'clean repo'}`
              : 'watching'}
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
              <span>Review state</span>
              <strong>{reviewPacket.reviewDisposition}</strong>
              <p className="muted">
                {reviewPacket.reviewDispositionUpdatedAtLabel
                  ? `Last changed ${reviewPacket.reviewDispositionUpdatedAtLabel}`
                  : 'No explicit operator disposition yet.'}
              </p>
            </div>
          </div>

          <div className="operator-actions queue-toolbar top-gap">
            <button
              type="button"
              onClick={() => reviewPacket.changedFiles[0] && onOpenReviewFile(reviewPacket.changedFiles[0].path)}
              disabled={actionState !== 'idle' || !reviewPacket.changedFiles.length}
            >
              {reviewFileLoading ? 'Opening diff…' : 'Open exact diff context'}
            </button>
            <button
              type="button"
              onClick={onLoadCorrectionDraft}
              disabled={actionState !== 'idle' || !canSendInput}
            >
              Resume with correction
            </button>
            <button
              type="button"
              onClick={onToggleDisposition}
              disabled={actionState !== 'idle'}
            >
              {reviewPacket.reviewDisposition === 'resolved' ? 'Keep watching' : 'Mark resolved'}
            </button>
          </div>

          <div className="workflow-warning-list">
            <p className="muted workflow-note">{reviewPacket.summary}</p>
            <p className="muted workflow-note">
              Next actions: {reviewPacket.nextActions.join(' • ') || 'Review the latest evidence.'}
            </p>
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
                    <button
                      key={`${file.status}:${file.path}`}
                      type="button"
                      className={`workflow-file-item ${reviewFile?.path === file.path ? 'workflow-file-item-active' : ''}`}
                      onClick={() => onOpenReviewFile(file.path)}
                    >
                      <div className="row space-between compact-row">
                        <strong className="mono">{file.path}</strong>
                        <span className="status-pill status-reviewing">{file.status}</span>
                      </div>
                      <p className="muted mono">+{file.additions ?? '—'} / -{file.deletions ?? '—'}</p>
                    </button>
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

          {reviewFile || reviewFileLoading || reviewFileError ? (
            <div className="inset-card inspector-block tool-shell terminal-shell top-gap">
              <div className="row space-between compact-row operator-header-row">
                <div>
                  <span>Exact diff context</span>
                  <strong>{reviewFile?.path ?? 'Opening file context…'}</strong>
                </div>
                <span className={`status-pill ${reviewFile?.status ? 'status-reviewing' : 'status-running'}`}>
                  {reviewFileLoading ? 'loading' : reviewFile?.status ?? 'diff'}
                </span>
              </div>
              {reviewFileError ? <p className="muted workflow-note">{reviewFileError}</p> : null}
              {reviewFile ? (
                <>
                  <p className="muted workflow-note">{reviewFile.note}</p>
                  <p className="muted mono">+{reviewFile.additions ?? '—'} / -{reviewFile.deletions ?? '—'}</p>
                  <pre className="terminal-preview">{reviewFile.preview}</pre>
                </>
              ) : reviewFileLoading ? (
                <p className="muted workflow-note">Loading exact diff context…</p>
              ) : null}
            </div>
          ) : null}
        </>
      ) : reviewLoading ? (
        <p className="muted operator-note">Loading review packet…</p>
      ) : (
        <p className="muted operator-note">No review packet is available for this owned surface yet.</p>
      )}
    </div>
  );
});

export function SessionOperatorPanel({
  agent,
  compact = false,
  onRuntimeRefresh,
  realtimePrimary = false,
  onBeginOptimisticMutation,
  onSettleOptimisticMutation,
}: {
  agent: AgentSummary;
  compact?: boolean;
  onRuntimeRefresh?: (preferredId?: string) => Promise<unknown> | unknown;
  realtimePrimary?: boolean;
  onBeginOptimisticMutation?: (mutation: Omit<RealtimeMutationRecord, 'createdAt'>) => RealtimeMutationRecord;
  onSettleOptimisticMutation?: (
    mutation: RealtimeMutationRecord,
    overrides: Partial<RealtimeMutationRecord>,
  ) => void;
}) {
  const [draft, setDraft] = useState('');
  const [history, setHistory] = useState<RuntimeLogEntry[]>([]);
  const [ownedGroups, setOwnedGroups] = useState<OwnedRuntimeTailGroup[]>([]);
  const [reviewPacket, setReviewPacket] = useState<RuntimeReviewPacket | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewFile, setReviewFile] = useState<ReviewFileDetail | null>(null);
  const [reviewFileLoading, setReviewFileLoading] = useState(false);
  const [reviewFileError, setReviewFileError] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [actionState, setActionState] = useState<'idle' | 'sending' | 'stopping' | 'reviewing'>('idle');
  const [actionNote, setActionNote] = useState<string | null>(null);
  const draftRef = useRef<HTMLTextAreaElement | null>(null);
  const transcriptLimit = compact ? 6 : 10;
  const liveRunVisible = ['running', 'reviewing'].includes(agent.status);
  const runtimeSurface = agent.runtimeSurface;
  const browserSurface = agent.browserSurface ?? runtimeSurface?.browserSurface;
  const isOpenClaw = agent.runtime === 'openclaw';
  const isOwnedCodex = agent.runtime === 'codex' && runtimeSurface?.ownership === 'owned';
  const agentSessionRef = useRef(agent.sessionKey);
  const reviewSurfaceRef = useRef(runtimeSurface?.id ?? '');
  const transcriptRequestRef = useRef(0);
  const reviewPacketRequestRef = useRef(0);
  const reviewFileRequestRef = useRef(0);
  const hasActionLane = isOpenClaw || isOwnedCodex;
  const canSendInput = Boolean(runtimeSurface?.capabilities.sendInput);
  const canInterrupt = Boolean(runtimeSurface?.capabilities.interrupt);
  const ownedLifecycleLabel = lifecycleLabel(agent);
  const ownedLastOutcomeLabel = lastOutcomeLabel(agent);

  const beginMutation = useCallback((action: string, note: string) => {
    if (!onBeginOptimisticMutation) return null;
    return onBeginOptimisticMutation({
      mutationId: (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
        ? crypto.randomUUID()
        : `mutation-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      source: 'desktop',
      action,
      runtime: agent.runtime,
      surfaceId: runtimeSurface?.id ?? agent.sessionKey,
      sessionKey: agent.sessionKey,
      note,
      optimistic: true,
      status: 'pending',
    });
  }, [agent.runtime, agent.sessionKey, onBeginOptimisticMutation, runtimeSurface?.id]);

  const settleMutation = useCallback((
    mutation: RealtimeMutationRecord | null,
    overrides: Partial<RealtimeMutationRecord>,
  ) => {
    if (!mutation || !onSettleOptimisticMutation) return;
    onSettleOptimisticMutation(mutation, overrides);
  }, [onSettleOptimisticMutation]);

  const refreshRuntimeFallback = useCallback(async (preferredId?: string) => {
    if (realtimePrimary) return;
    await onRuntimeRefresh?.(preferredId);
  }, [onRuntimeRefresh, realtimePrimary]);

  useEffect(() => {
    agentSessionRef.current = agent.sessionKey;
    reviewSurfaceRef.current = runtimeSurface?.id ?? '';
  }, [agent.sessionKey, runtimeSurface?.id]);

  const loadTranscript = useCallback(async (fresh = false) => {
    const requestId = ++transcriptRequestRef.current;
    setHistoryLoading(true);
    try {
      if (isOpenClaw) {
        const response = await fetch(
          `/api/openclaw/history?sessionKey=${encodeURIComponent(agent.sessionKey)}&limit=${transcriptLimit}${fresh ? '&fresh=1' : ''}`,
          {
            cache: 'no-store',
          },
        );
        const payload = await readJson<{ transcript?: SessionTranscriptEntry[] }>(response);
        if (agentSessionRef.current !== agent.sessionKey || transcriptRequestRef.current !== requestId) return;
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
        if (reviewSurfaceRef.current !== (runtimeSurface?.id ?? '') || transcriptRequestRef.current !== requestId) return;
        setHistory(payload.entries ?? []);
        setOwnedGroups(payload.groups ?? []);
      } else {
        if (agentSessionRef.current !== agent.sessionKey || transcriptRequestRef.current !== requestId) return;
        setHistory([]);
        setOwnedGroups([]);
      }
      setHistoryError(null);
    } catch (error) {
      if (agentSessionRef.current !== agent.sessionKey || transcriptRequestRef.current !== requestId) return;
      setHistoryError(error instanceof Error ? error.message : 'Unable to load runtime history');
    } finally {
      if (transcriptRequestRef.current === requestId) {
        setHistoryLoading(false);
      }
    }
  }, [agent.sessionKey, isOpenClaw, runtimeSurface, transcriptLimit]);

  const loadReviewPacket = useCallback(async () => {
    if (!isOwnedCodex || !runtimeSurface?.id) {
      setReviewPacket(null);
      setReviewError(null);
      return;
    }

    const requestId = ++reviewPacketRequestRef.current;
    setReviewLoading(true);
    try {
      const response = await fetch(`/api/runtime/review?surfaceId=${encodeURIComponent(runtimeSurface.id)}`, {
        cache: 'no-store',
      });
      const payload = await readJson<RuntimeReviewPacket>(response);
      if (reviewSurfaceRef.current !== runtimeSurface.id || reviewPacketRequestRef.current !== requestId) return;
      setReviewPacket(payload);
      setReviewError(null);
    } catch (error) {
      if (reviewSurfaceRef.current !== runtimeSurface.id || reviewPacketRequestRef.current !== requestId) return;
      setReviewError(error instanceof Error ? error.message : 'Unable to load runtime review packet');
    } finally {
      if (reviewPacketRequestRef.current === requestId) {
        setReviewLoading(false);
      }
    }
  }, [isOwnedCodex, runtimeSurface]);

  const loadReviewFile = useCallback(async (reviewPath: string) => {
    const requestId = ++reviewFileRequestRef.current;
    setReviewFileLoading(true);
    try {
      const response = await fetch(`/api/review/file?path=${encodeURIComponent(reviewPath)}`, {
        cache: 'no-store',
      });
      const payload = await readJson<{ file: ReviewFileDetail }>(response);
      if (reviewFileRequestRef.current !== requestId) return;
      setReviewFile(payload.file);
      setReviewFileError(null);
    } catch (error) {
      if (reviewFileRequestRef.current !== requestId) return;
      setReviewFileError(error instanceof Error ? error.message : 'Unable to load exact diff context');
    } finally {
      if (reviewFileRequestRef.current === requestId) {
        setReviewFileLoading(false);
      }
    }
  }, []);

  async function handleReviewDisposition(action: 'watch' | 'resolve') {
    if (!runtimeSurface?.id || !isOwnedCodex) return;
    setActionState('reviewing');
    setActionNote(null);
    const mutation = beginMutation(action, action === 'resolve' ? 'Resolving review packet…' : 'Keeping review packet watching…');

    try {
      const response = await fetch('/api/runtime/action', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action,
          surfaceId: runtimeSurface.id,
          clientMutationId: mutation?.mutationId,
        }),
      });
      const result = await readJson<{ note?: string }>(response);
      setActionNote(result.note ?? (action === 'resolve' ? 'Marked resolved.' : 'Switched back to keep-watching.'));
      settleMutation(mutation, {
        status: 'completed',
        note: result.note ?? (action === 'resolve' ? 'Marked resolved.' : 'Switched back to keep-watching.'),
      });
      await loadReviewPacket();
      await refreshRuntimeFallback(agent.id);
    } catch (error) {
      const note = error instanceof Error ? error.message : 'Unable to update review disposition';
      settleMutation(mutation, { status: 'failed', note });
      setActionNote(note);
    } finally {
      setActionState('idle');
    }
  }

  function handleLoadCorrectionDraft() {
    if (!reviewPacket) return;
    setDraft(buildCorrectionDraft(reviewPacket));
    setActionNote('Loaded a correction draft grounded in the current packet. Review it or send it as-is.');
    draftRef.current?.focus();
  }

  useEffect(() => {
    setDraft('');
    setActionNote(null);
    setReviewFile(null);
    setReviewFileError(null);
    void loadTranscript();
    void loadReviewPacket();
  }, [agent.sessionKey, loadTranscript, loadReviewPacket]);

  async function handleSteerSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const instruction = draft.trim();
    if (!instruction || !canSendInput) return;

    setActionState('sending');
    setActionNote(null);
    const mutation = beginMutation('steer', 'Steer request queued on the live session.');

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
          clientMutationId: mutation?.mutationId,
        }),
      });
      const result = await readJson<{ note: string }>(response);
      setDraft('');
      setActionNote(result.note ?? 'Steer request queued on the live session. External delivery stays off by default.');
      settleMutation(mutation, {
        status: 'queued',
        note: result.note ?? 'Steer request queued on the live session. External delivery stays off by default.',
      });
      await loadTranscript(true);
      await loadReviewPacket();
      await refreshRuntimeFallback(agent.id);
      if (!realtimePrimary) {
        window.setTimeout(() => {
          void loadTranscript(true);
          void loadReviewPacket();
          void refreshRuntimeFallback(agent.id);
        }, 1200);
      }
    } catch (error) {
      const note = error instanceof Error ? error.message : 'Unable to steer the session';
      settleMutation(mutation, { status: 'failed', note });
      setActionNote(note);
    } finally {
      setActionState('idle');
    }
  }

  async function handleStop() {
    if (!canInterrupt) return;

    setActionState('stopping');
    setActionNote(null);
    const mutation = beginMutation('stop', 'Stop request sent to the active run for this session.');

    try {
      const response = await fetch('/api/runtime/action', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'stop',
          surfaceId: runtimeSurface?.id ?? agent.sessionKey,
          clientMutationId: mutation?.mutationId,
        }),
      });
      const payload = await readJson<{ aborted?: boolean; note?: string }>(response);
      setActionNote(
        payload.note
          ?? (payload.aborted
            ? 'Stop request sent to the active run for this session.'
            : 'No active run was in flight for this session.'),
      );
      settleMutation(mutation, {
        status: 'completed',
        note: payload.note
          ?? (payload.aborted
            ? 'Stop request sent to the active run for this session.'
            : 'No active run was in flight for this session.'),
      });
      await loadTranscript(true);
      await loadReviewPacket();
      await refreshRuntimeFallback(agent.id);
      if (!realtimePrimary) {
        window.setTimeout(() => {
          void loadTranscript(true);
          void loadReviewPacket();
          void refreshRuntimeFallback(agent.id);
        }, 1200);
      }
    } catch (error) {
      const note = error instanceof Error ? error.message : 'Unable to stop the session';
      settleMutation(mutation, { status: 'failed', note });
      setActionNote(note);
    } finally {
      setActionState('idle');
    }
  }

  return (
    <>
      <OperatorActionsPanel
        agent={agent}
        compact={compact}
        runtimeSurface={runtimeSurface}
        isOpenClaw={isOpenClaw}
        isOwnedCodex={isOwnedCodex}
        hasActionLane={hasActionLane}
        liveRunVisible={liveRunVisible}
        canSendInput={canSendInput}
        canInterrupt={canInterrupt}
        ownedLifecycleLabel={ownedLifecycleLabel}
        ownedLastOutcomeLabel={ownedLastOutcomeLabel}
        historyLoading={historyLoading}
        historyLength={history.length}
        ownedGroupsLength={ownedGroups.length}
        draft={draft}
        setDraft={setDraft}
        draftRef={draftRef}
        actionState={actionState}
        actionNote={actionNote}
        onSubmit={handleSteerSubmit}
        onStop={handleStop}
        onRefreshTranscript={() => { void loadTranscript(); }}
      />

      {browserSurface ? (
        <div className="inset-card inspector-block tool-shell">
          <div className="row space-between compact-row operator-header-row">
            <div>
              <span>Browser surface</span>
              <strong>{browserSurface.title ?? browserSurface.url ?? 'Observed browser lane'}</strong>
            </div>
            <span className={`status-pill status-${browserStatusTone(browserSurface.status)}`}>
              {browserSurface.provider} • {browserSurface.status}
            </span>
          </div>
          <p className="muted operator-note">
            Read-only for now. This mirrors browser activity already visible to the runtime so we can attach truthful browser controls later without inventing a second session model.
          </p>
          <div className="operator-state-grid">
            <div className="operator-state-card">
              <span>Provider / ownership</span>
              <strong>{browserSurface.provider}</strong>
              <p className="muted">{browserSurface.ownership} surface • {browserSurface.sourceLabel}</p>
            </div>
            <div className="operator-state-card">
              <span>Current page</span>
              <strong>{browserSurface.title ?? 'Untitled page'}</strong>
              <p className="muted mono">{browserSurface.url ?? 'URL unavailable'}</p>
            </div>
            <div className="operator-state-card">
              <span>Profile persistence</span>
              <strong>{browserSurface.capabilities.persistentProfile ? 'persistent' : 'ephemeral'}</strong>
              <p className="muted mono">{browserSurface.profileId ?? 'No profile id exposed yet'}</p>
            </div>
          </div>
          <div className="workflow-file-list">
            <div className="workflow-file-item">
              <div className="row space-between compact-row">
                <strong>Last observed action</strong>
                <span className="muted mono">{browserTimestampLabel(browserSurface.lastActionAt)}</span>
              </div>
              <p className="muted">{browserActionLabel(browserSurface)}</p>
            </div>
            <div className="workflow-file-item">
              <div className="row space-between compact-row">
                <strong>Session / page identity</strong>
                <span className="status-pill status-warning">mirror-only</span>
              </div>
              <p className="muted mono">
                session={browserSurface.browserSessionId ?? browserSurface.sessionKey ?? 'unknown'}
                {' • '}
                page={browserSurface.pageId ?? 'unknown'}
              </p>
            </div>
          </div>
        </div>
      ) : null}

      {isOwnedCodex ? (
        <OwnedReviewPanel
          reviewPacket={reviewPacket}
          reviewLoading={reviewLoading}
          reviewError={reviewError}
          reviewFile={reviewFile}
          reviewFileLoading={reviewFileLoading}
          reviewFileError={reviewFileError}
          actionState={actionState}
          canSendInput={canSendInput}
          onOpenReviewFile={(reviewPath) => { void loadReviewFile(reviewPath); }}
          onLoadCorrectionDraft={handleLoadCorrectionDraft}
          onToggleDisposition={() => {
            if (!reviewPacket) return;
            void handleReviewDisposition(reviewPacket.reviewDisposition === 'resolved' ? 'watch' : 'resolve');
          }}
        />
      ) : null}

      <RuntimeTailPanel
        isOpenClaw={isOpenClaw}
        isOwnedCodex={isOwnedCodex}
        historyLoading={historyLoading}
        historyError={historyError}
        history={history}
        ownedGroups={ownedGroups}
      />
    </>
  );
}
