'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { SessionOperatorPanel } from '@/components/session-operator-panel';
import type {
  MobileActionRequest,
  MobileActionResponse,
  MobileControlAction,
  MobileHistoryResponse,
  MobileInboxSnapshot,
  MobileReviewFileResponse,
  MobileTranscriptEntry,
} from '@/lib/mobile/types';

function pickCurrentSession(snapshot: MobileInboxSnapshot) {
  return snapshot.sessions.find((session) => session.isCurrentSession)
    ?? snapshot.sessions.find((session) => session.sessionKey === snapshot.primarySessionKey)
    ?? snapshot.sessions[0];
}

function statusClass(kind: string) {
  switch (kind) {
    case 'critical':
      return 'status-critical';
    case 'warning':
      return 'status-warning';
    case 'success':
      return 'status-success';
    case 'info':
    default:
      return 'status-info';
  }
}

function roleLabel(role: MobileTranscriptEntry['role']) {
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

function compactLine(text: string | null | undefined, fallback: string, max = 84) {
  const value = text?.trim() || fallback;
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
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

export function MobileRemoteShell({ initialSnapshot }: { initialSnapshot: MobileInboxSnapshot }) {
  const [snapshot, setSnapshot] = useState<MobileInboxSnapshot>(initialSnapshot);
  const [selectedId, setSelectedId] = useState(() => pickCurrentSession(initialSnapshot)?.id ?? '');
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [actionHint, setActionHint] = useState<string | null>(null);
  const [expandedSessionKey, setExpandedSessionKey] = useState<string | null>(null);
  const [composeSessionKey, setComposeSessionKey] = useState<string | null>(null);
  const [historyBySession, setHistoryBySession] = useState<Record<string, MobileTranscriptEntry[]>>({});
  const [historyLoading, setHistoryLoading] = useState<Record<string, boolean>>({});
  const [historyError, setHistoryError] = useState<Record<string, string | null>>({});
  const [draftBySession, setDraftBySession] = useState<Record<string, string>>({});
  const [actionStateBySession, setActionStateBySession] = useState<Record<string, 'idle' | 'steering' | 'stopping'>>({});
  const [actionNoteBySession, setActionNoteBySession] = useState<Record<string, string | null>>({});
  const [selectedReviewFilePath, setSelectedReviewFilePath] = useState<string | null>(null);
  const [reviewFileByPath, setReviewFileByPath] = useState<Record<string, MobileReviewFileResponse['file']>>({});
  const [reviewFileLoadingPath, setReviewFileLoadingPath] = useState<string | null>(null);
  const [reviewFileError, setReviewFileError] = useState<string | null>(null);
  const [queueExpanded, setQueueExpanded] = useState(false);
  const [reviewExpanded, setReviewExpanded] = useState(false);
  const [operatorOpen, setOperatorOpen] = useState(false);

  async function refreshInbox() {
    const response = await fetch('/api/mobile/inbox', { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const nextSnapshot = (await response.json()) as MobileInboxSnapshot;
    setSnapshot(nextSnapshot);
    setRefreshError(null);
    return nextSnapshot;
  }

  useEffect(() => {
    let active = true;

    async function refreshLiveInbox() {
      try {
        const nextSnapshot = await fetch('/api/mobile/inbox', { cache: 'no-store' }).then(async (response) => {
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }
          return (await response.json()) as MobileInboxSnapshot;
        });
        if (!active) return;
        setSnapshot(nextSnapshot);
        setRefreshError(null);
      } catch (error) {
        if (!active) return;
        setRefreshError(error instanceof Error ? error.message : 'Unable to refresh mobile inbox');
      }
    }

    void refreshLiveInbox();
    const timer = window.setInterval(() => {
      void refreshLiveInbox();
    }, 30000);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    setSelectedId((currentId) => {
      if (currentId && snapshot.sessions.some((session) => session.id === currentId)) {
        return currentId;
      }
      return pickCurrentSession(snapshot)?.id ?? '';
    });
  }, [snapshot]);

  const selectedSession = useMemo(
    () => snapshot.sessions.find((session) => session.id === selectedId) ?? pickCurrentSession(snapshot),
    [selectedId, snapshot],
  );

  const visibleQueueItems = useMemo(
    () => (queueExpanded ? snapshot.items : snapshot.items.slice(0, 3)),
    [queueExpanded, snapshot.items],
  );

  const hiddenQueueCount = Math.max(snapshot.items.length - visibleQueueItems.length, 0);
  const visibleReviewFiles = useMemo(
    () => (reviewExpanded ? snapshot.review?.changedFiles ?? [] : (snapshot.review?.changedFiles ?? []).slice(0, 3)),
    [reviewExpanded, snapshot.review?.changedFiles],
  );
  const hiddenReviewCount = Math.max((snapshot.review?.changedFiles.length ?? 0) - visibleReviewFiles.length, 0);

  useEffect(() => {
    if (!selectedReviewFilePath) {
      return;
    }

    if (!snapshot.review?.changedFiles.some((file) => file.path === selectedReviewFilePath)) {
      setSelectedReviewFilePath(null);
      setReviewFileError(null);
    }
  }, [selectedReviewFilePath, snapshot.review]);

  function syncSelection(sessionKey: string) {
    const matchingSession = snapshot.sessions.find((session) => session.sessionKey === sessionKey);
    if (!matchingSession) {
      return null;
    }

    setSelectedId(matchingSession.id);
    return matchingSession;
  }

  async function loadHistory(sessionKey: string, force = false) {
    if (!force && historyBySession[sessionKey]?.length) {
      return historyBySession[sessionKey];
    }

    setHistoryLoading((current) => ({ ...current, [sessionKey]: true }));
    try {
      const response = await fetch(`/api/mobile/history?sessionKey=${encodeURIComponent(sessionKey)}&limit=6`, {
        cache: 'no-store',
      });
      const payload = await readJson<MobileHistoryResponse>(response);
      setHistoryBySession((current) => ({ ...current, [sessionKey]: payload.transcript }));
      setHistoryError((current) => ({ ...current, [sessionKey]: null }));
      return payload.transcript;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to load session history';
      setHistoryError((current) => ({ ...current, [sessionKey]: message }));
      throw error;
    } finally {
      setHistoryLoading((current) => ({ ...current, [sessionKey]: false }));
    }
  }

  async function loadReviewFile(reviewPath: string, force = false) {
    if (!force && reviewFileByPath[reviewPath]) {
      setReviewFileError(null);
      return reviewFileByPath[reviewPath];
    }

    setReviewFileLoadingPath(reviewPath);
    setReviewFileError(null);
    try {
      const response = await fetch(`/api/mobile/review-file?path=${encodeURIComponent(reviewPath)}`, {
        cache: 'no-store',
      });
      const payload = await readJson<MobileReviewFileResponse>(response);
      setReviewFileByPath((current) => ({ ...current, [reviewPath]: payload.file }));
      return payload.file;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to load the per-file review preview.';
      setReviewFileError(message);
      throw error;
    } finally {
      setReviewFileLoadingPath((current) => (current === reviewPath ? null : current));
    }
  }

  async function handleReviewFileSelect(reviewPath: string) {
    if (selectedReviewFilePath === reviewPath) {
      setSelectedReviewFilePath(null);
      setReviewFileError(null);
      return;
    }

    setSelectedReviewFilePath(reviewPath);
    try {
      await loadReviewFile(reviewPath);
    } catch {
      // reviewFileError already captures the route failure for the inline surface
    }
  }

  async function runAction(payload: MobileActionRequest) {
    const sessionKey = payload.sessionKey;
    setActionStateBySession((current) => ({
      ...current,
      [sessionKey]: payload.action === 'stop' ? 'stopping' : 'steering',
    }));

    try {
      const response = await fetch('/api/mobile/action', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      const result = await readJson<MobileActionResponse>(response);
      setActionNoteBySession((current) => ({ ...current, [sessionKey]: result.note }));
      await refreshInbox();
      if (expandedSessionKey === sessionKey || payload.action === 'steer') {
        await loadHistory(sessionKey, true).catch(() => undefined);
      }
      return result;
    } finally {
      setActionStateBySession((current) => ({ ...current, [sessionKey]: 'idle' }));
    }
  }

  async function handleAction(action: MobileControlAction) {
    if (!action.available) {
      setActionHint(action.reasonUnavailable ?? 'That action is not wired yet on this adapter.');
      return;
    }

    if (action.href) {
      setActionHint('This action lives on the desktop review surface.');
      return;
    }

    if (!action.sessionKey) {
      setActionHint('This action needs a live session key, and none is visible here.');
      return;
    }

    const sessionKey = action.sessionKey;
    const matchingSession = syncSelection(sessionKey);
    if (!matchingSession) {
      setActionHint('That session is no longer visible in the live mirror.');
      return;
    }

    switch (action.kind) {
      case 'inspect': {
        const nextExpanded = expandedSessionKey === sessionKey ? null : sessionKey;
        setExpandedSessionKey(nextExpanded);
        if (nextExpanded) {
          try {
            await loadHistory(sessionKey);
            setActionHint('Inline history loaded for this session.');
          } catch {
            setActionHint('Tried to load inline history, but the route returned an error.');
          }
        }
        return;
      }
      case 'steer': {
        setComposeSessionKey((current) => (current === sessionKey ? null : sessionKey));
        setExpandedSessionKey(sessionKey);
        await loadHistory(sessionKey).catch(() => undefined);
        setActionHint('Inline steer composer opened on this card.');
        return;
      }
      case 'stop': {
        const confirmed = window.confirm('Stop the active run for this session?');
        if (!confirmed) {
          return;
        }
        try {
          await runAction({ action: 'stop', sessionKey });
          setActionHint('Stop action sent directly from the inbox card.');
        } catch (error) {
          setActionHint(error instanceof Error ? error.message : 'Unable to stop the session from mobile.');
        }
        return;
      }
      default:
        setActionHint(`${action.kind} is part of the contract, but not directly wired on this card yet.`);
    }
  }

  async function handleSteerSubmit(sessionKey: string) {
    const message = draftBySession[sessionKey]?.trim();
    if (!message) {
      setActionNoteBySession((current) => ({ ...current, [sessionKey]: 'Steer message is required.' }));
      return;
    }

    try {
      await runAction({
        action: 'steer',
        sessionKey,
        message,
      });
      setDraftBySession((current) => ({ ...current, [sessionKey]: '' }));
      setExpandedSessionKey(sessionKey);
      setActionHint('Steer request queued directly from the inbox card.');
    } catch (error) {
      setActionNoteBySession((current) => ({
        ...current,
        [sessionKey]: error instanceof Error ? error.message : 'Unable to steer the session from mobile.',
      }));
    }
  }

  return (
    <div className="mobile-wrap">
      <header className="surface-card mobile-header">
        <div>
          <div className="eyebrow">Cortex IDE Remote</div>
          <h1>Mobile control inbox</h1>
          <p className="muted">
            Phone stays operator-first: alerts, blockers, run watch, and review-ready awareness. Desktop stays
            the heavy execution surface.
          </p>
        </div>
        <Link href="/" className="inline-link">
          Back to desktop ↗
        </Link>
      </header>

      <section className="surface-card mobile-panel-surface mobile-panel-compact">
        <div className="section-head">
          <div>
            <div className="eyebrow">At a glance</div>
            <h2>Remote tasking queue</h2>
          </div>
          <span className={`status-pill ${statusClass(refreshError ? 'warning' : snapshot.mode === 'live' ? 'success' : 'warning')}`}>
            {refreshError ? 'warning' : snapshot.mode === 'live' ? 'live' : 'demo'}
          </span>
        </div>
        <p className="muted section-caption">
          Compact mobile pass: less narration, stronger hierarchy, same truthful control lane.
        </p>
        <div className="toolbar-strip toolbar-strip-primary">
          <div className="toolbar-chip toolbar-chip-strong">
            <span>Now</span>
            <strong>{selectedSession?.isCurrentSession ? 'This chat' : selectedSession?.name ?? 'Queue mirror'}</strong>
            <p>{selectedSession?.isCurrentSession ? 'Q ↔ Mister live' : compactLine(selectedSession?.name, 'Freshest live session', 38)}</p>
          </div>
          <div className="toolbar-chip toolbar-chip-strong">
            <span>Review</span>
            <strong>
              {snapshot.review?.pullRequest
                ? `PR #${snapshot.review.pullRequest.number}`
                : snapshot.review?.branch ?? 'No lane'}
            </strong>
            <p>{compactLine(snapshot.review?.pullRequest?.title ?? snapshot.review?.branch, 'No review lane yet', 42)}</p>
          </div>
        </div>
        <div className="toolbar-strip toolbar-strip-secondary toolbar-strip-metrics">
          <div className="toolbar-chip toolbar-chip-stat">
            <span>Hot</span>
            <strong>{snapshot.summary.activeRuns}</strong>
            <p>runs</p>
          </div>
          <div className="toolbar-chip toolbar-chip-stat">
            <span>Alerts</span>
            <strong>{snapshot.summary.alerts}</strong>
            <p>need eyes</p>
          </div>
          <div className="toolbar-chip toolbar-chip-stat">
            <span>Review</span>
            <strong>{snapshot.summary.reviewItems}</strong>
            <p>ready</p>
          </div>
          <div className="toolbar-chip toolbar-chip-stat">
            <span>Approvals</span>
            <strong>{snapshot.summary.approvals}</strong>
            <p>pending</p>
          </div>
        </div>
        <div className="queue-toolbar toolbar-link-row compact-link-row">
          <Link href="/" className="mobile-action-link">
            Desktop ↗
          </Link>
          {snapshot.review ? (
            <Link href={snapshot.review.desktopHref} className="mobile-action-link">
              Review ↗
            </Link>
          ) : (
            <div className="mobile-action-link mobile-action-link-disabled">Review soon</div>
          )}
          {snapshot.review?.pullRequest ? (
            <a href={snapshot.review.pullRequest.url} target="_blank" rel="noreferrer" className="mobile-action-link">
              GitHub ↗
            </a>
          ) : (
            <div className="mobile-action-link mobile-action-link-disabled">No PR</div>
          )}
          <button type="button" onClick={() => window.location.reload()}>
            Refresh
          </button>
        </div>
      </section>

      <section className="surface-card mobile-panel-surface mobile-panel-compact">
        <div className="section-head">
          <div>
            <div className="eyebrow">Now + queue</div>
            <h2>Live operator queue</h2>
          </div>
          <span className={`status-pill ${refreshError ? 'status-warning' : 'status-success'}`}>
            {refreshError ? 'warning' : `${snapshot.items.length} live`}
          </span>
        </div>
        <p className="muted section-caption">
          Lead with what matters now. Keep the rest available without turning the screen into a dump.
        </p>
        {actionHint ? <p className="muted operator-note compact-note">{actionHint}</p> : null}
        <div className="mobile-stack mobile-stack-tight">
          {visibleQueueItems.map((item, index) => {
            const sessionKey = item.sessionKey;
            const inlineHistory = sessionKey ? historyBySession[sessionKey] ?? [] : [];
            const inlineHistoryError = sessionKey ? historyError[sessionKey] : null;
            const inlineHistoryLoading = sessionKey ? historyLoading[sessionKey] : false;
            const inlineActionState = sessionKey ? actionStateBySession[sessionKey] ?? 'idle' : 'idle';
            const inlineActionNote = sessionKey ? actionNoteBySession[sessionKey] : null;
            const inlineDraft = sessionKey ? draftBySession[sessionKey] ?? '' : '';
            const historyOpen = Boolean(sessionKey && expandedSessionKey === sessionKey);
            const composeOpen = Boolean(sessionKey && composeSessionKey === sessionKey);
            const visibleActions = index === 0 ? item.actions.slice(0, 3) : item.actions.slice(0, 2);

            return (
              <div key={item.id} className={`mobile-action-card queue-card ${index === 0 ? 'queue-card-featured' : 'queue-card-secondary'}`}>
                <div className="row space-between compact-row queue-card-head">
                  <div>
                    <div className="queue-kicker">{index === 0 ? 'Now' : 'Queued'}</div>
                    <h3>{compactLine(item.title, 'Queue item', 46)}</h3>
                    <p>{compactLine(item.detail, 'Open the live session for more detail.', index === 0 ? 82 : 76)}</p>
                  </div>
                  <span className={`status-pill ${statusClass(item.severity)}`}>{item.kind.replace('_', ' ')}</span>
                </div>
                <div className="queue-meta-row">
                  <span className="muted mono queue-meta-pill">{item.timestampLabel ?? 'now'}</span>
                  {sessionKey ? <span className="muted mono queue-meta-pill">{compactLine(sessionKey, sessionKey, 30)}</span> : null}
                </div>
                <div className="tool-drawer-list tool-drawer-list-mobile queue-toolbar">
                  {visibleActions.map((action) => (
                    action.href ? (
                      action.href.startsWith('http') ? (
                        <a
                          key={`${item.id}:${action.kind}`}
                          href={action.href}
                          target="_blank"
                          rel="noreferrer"
                          className="mobile-action-link"
                        >
                          {action.label}
                        </a>
                      ) : (
                        <Link key={`${item.id}:${action.kind}`} href={action.href} className="mobile-action-link">
                          {action.label}
                        </Link>
                      )
                    ) : (
                      <button
                        key={`${item.id}:${action.kind}`}
                        type="button"
                        onClick={() => {
                          void handleAction(action);
                        }}
                        disabled={!action.available || (Boolean(sessionKey) && inlineActionState !== 'idle' && action.kind !== 'inspect')}
                      >
                        {action.kind === 'inspect' && historyOpen
                          ? 'Hide log'
                          : action.kind === 'steer' && composeOpen
                            ? 'Close steer'
                            : action.kind === 'stop' && inlineActionState === 'stopping'
                              ? 'Stopping…'
                              : action.label}
                      </button>
                    )
                  ))}
                </div>
                {item.actions.length > visibleActions.length ? (
                  <span className="queue-action-caption">+{item.actions.length - visibleActions.length} more actions inside the full operator view</span>
                ) : null}

                {composeOpen && sessionKey ? (
                  <div className="inset-card tool-shell">
                    <div className="row space-between compact-row operator-header-row">
                      <div>
                        <span>Direct steer</span>
                        <strong>Send from inbox</strong>
                      </div>
                      <span className="status-pill status-running">/api/mobile/action</span>
                    </div>
                    <div className="operator-form top-gap">
                      <textarea
                        className="operator-textarea"
                        rows={3}
                        value={inlineDraft}
                        onChange={(event) => {
                          const value = event.target.value;
                          setDraftBySession((current) => ({ ...current, [sessionKey]: value }));
                        }}
                        placeholder="Steer this live session directly from the mobile inbox…"
                      />
                      <div className="operator-actions">
                        <button
                          className="button-primary"
                          type="button"
                          disabled={inlineActionState !== 'idle' || !inlineDraft.trim()}
                          onClick={() => {
                            void handleSteerSubmit(sessionKey);
                          }}
                        >
                          {inlineActionState === 'steering' ? 'Sending…' : 'Send steer'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setComposeSessionKey(null)}
                          disabled={inlineActionState !== 'idle'}
                        >
                          Close
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            void loadHistory(sessionKey, true);
                          }}
                          disabled={inlineActionState !== 'idle' || inlineHistoryLoading}
                        >
                          {inlineHistoryLoading ? 'Refreshing…' : 'Refresh log'}
                        </button>
                      </div>
                    </div>
                  </div>
                ) : null}

                {inlineActionNote ? <p className="muted operator-note">{inlineActionNote}</p> : null}

                {historyOpen && sessionKey ? (
                  <div className="inset-card tool-shell terminal-shell">
                    <div className="row space-between compact-row operator-header-row">
                      <div>
                        <span>Inline history</span>
                        <strong>Phone-side run watch</strong>
                      </div>
                      <span className="status-pill status-healthy">/api/mobile/history</span>
                    </div>
                    <p className="muted operator-note">
                      This is the tighter mobile watch lane: inspect the latest readable turns here without dropping into the full desktop operator surface.
                    </p>
                    {inlineHistoryError ? <p className="muted operator-note">{inlineHistoryError}</p> : null}
                    {inlineHistory.length ? (
                      <div className="transcript-list top-gap terminal-stack">
                        {inlineHistory.map((entry) => (
                          <div key={entry.id} className="transcript-entry terminal-entry">
                            <div className="row space-between compact-row">
                              <strong>{roleLabel(entry.role)}</strong>
                              <span className="muted mono">{entry.timestampLabel ?? 'now'}</span>
                            </div>
                            <p>{entry.text}</p>
                          </div>
                        ))}
                      </div>
                    ) : inlineHistoryLoading ? (
                      <p className="muted operator-note">Loading inline history…</p>
                    ) : (
                      <p className="muted operator-note">No readable transcript turns are visible for this session yet.</p>
                    )}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
        {hiddenQueueCount > 0 ? (
          <button
            type="button"
            className="queue-toggle"
            onClick={() => setQueueExpanded((current) => !current)}
          >
            {queueExpanded ? 'Show less queue' : `Show ${hiddenQueueCount} more queue item${hiddenQueueCount === 1 ? '' : 's'}`}
          </button>
        ) : null}
      </section>

      {snapshot.review ? (
        <section className="surface-card mobile-review-focus mobile-panel-surface mobile-panel-compact">
          <div className="section-head">
            <div>
              <div className="eyebrow">Review</div>
              <h2>Desktop lane, mobile triage</h2>
            </div>
            <span className={`status-pill ${statusClass(snapshot.review.changedFiles.length ? 'reviewing' : 'healthy')}`}>
              {snapshot.review.changedFiles.length ? `${snapshot.review.changedFiles.length} files` : 'clean'}
            </span>
          </div>

          <div className="mobile-review-headline compact-review-headline">
            <div>
              <span>Current lane</span>
              <strong>
                {snapshot.review.pullRequest
                  ? `PR #${snapshot.review.pullRequest.number} — ${compactLine(snapshot.review.pullRequest.title, snapshot.review.branch, 46)}`
                  : snapshot.review.branch}
              </strong>
              <p className="muted mono">{snapshot.review.branch}</p>
            </div>
            <div className="glass-link-row compact-link-row">
              <Link href={snapshot.review.desktopHref} className="mobile-action-link">
                Review ↗
              </Link>
              {snapshot.review.pullRequest ? (
                <a href={snapshot.review.pullRequest.url} target="_blank" rel="noreferrer" className="mobile-action-link">
                  GitHub ↗
                </a>
              ) : null}
            </div>
          </div>

          {snapshot.review.issues.length ? (
            <div className="glass-chip-grid compact-chip-grid">
              {snapshot.review.issues.map((issue) => (
                <a key={issue.number} href={issue.url} target="_blank" rel="noreferrer" className="glass-chip compact-chip">
                  {`#${issue.number}`}
                </a>
              ))}
            </div>
          ) : null}

          {snapshot.review.changedFiles.length ? (
            <>
              <p className="muted section-caption">
                Only the first few files stay open on mobile by default. The heavy review still belongs on desktop.
              </p>
              <div className="glass-file-list compact-file-list">
                {visibleReviewFiles.map((file) => {
                  const fileTone = file.status === 'deleted'
                    ? 'critical'
                    : file.status === 'untracked'
                      ? 'warning'
                      : file.status === 'renamed'
                        ? 'reviewing'
                        : file.status === 'added'
                          ? 'healthy'
                          : 'running';
                  const isSelected = selectedReviewFilePath === file.path;

                  return (
                    <button
                      key={`${file.status}:${file.path}`}
                      type="button"
                      className={`glass-file-row glass-file-button compact-file-row ${isSelected ? 'glass-file-row-active' : ''}`}
                      onClick={() => {
                        void handleReviewFileSelect(file.path);
                      }}
                    >
                      <div className="row space-between compact-row">
                        <strong className="mono">{compactLine(file.path, file.path, 42)}</strong>
                        <span className={`status-pill ${statusClass(fileTone)}`}>
                          {file.status}
                        </span>
                      </div>
                      <p className="muted mono">
                        +{file.additions ?? 0} / -{file.deletions ?? 0}
                      </p>
                      <span className="glass-file-caption">
                        {isSelected ? 'Hide preview' : 'Open preview'}
                      </span>
                    </button>
                  );
                })}
              </div>
              {hiddenReviewCount > 0 ? (
                <button
                  type="button"
                  className="queue-toggle"
                  onClick={() => setReviewExpanded((current) => !current)}
                >
                  {reviewExpanded ? 'Show fewer files' : `Show ${hiddenReviewCount} more file${hiddenReviewCount === 1 ? '' : 's'}`}
                </button>
              ) : null}
            </>
          ) : null}

          {selectedReviewFilePath ? (
            <div className="glass-review-preview inset-card tool-shell terminal-shell">
              <div className="row space-between compact-row operator-header-row">
                <div>
                  <span>Per-file drilldown</span>
                  <strong className="mono">{selectedReviewFilePath}</strong>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    void loadReviewFile(selectedReviewFilePath, true);
                  }}
                  disabled={reviewFileLoadingPath === selectedReviewFilePath}
                >
                  {reviewFileLoadingPath === selectedReviewFilePath ? 'Refreshing…' : 'Refresh preview'}
                </button>
              </div>
              {reviewFileError ? <p className="muted operator-note">{reviewFileError}</p> : null}
              {reviewFileByPath[selectedReviewFilePath] ? (
                <>
                  <p className="muted operator-note compact-note">{compactLine(reviewFileByPath[selectedReviewFilePath].note, 'Inline review preview.', 120)}</p>
                  <pre className="glass-diff-preview terminal-output">{reviewFileByPath[selectedReviewFilePath].preview}</pre>
                </>
              ) : reviewFileLoadingPath === selectedReviewFilePath ? (
                <p className="muted operator-note">Loading per-file review preview…</p>
              ) : (
                <p className="muted operator-note">No inline review preview is cached for this file yet.</p>
              )}
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="surface-card mobile-panel-surface mobile-panel-compact">
        <div className="section-head">
          <div>
            <div className="eyebrow">Operator</div>
            <h2>Open tools only when you need them</h2>
          </div>
          <span className="status-pill status-info">{operatorOpen ? 'open' : 'collapsed'}</span>
        </div>
        <div className="mobile-memory-card queue-card compact-launcher-card">
          <div>
            <strong>{selectedSession?.name ?? 'No current session'}</strong>
            <p className="muted">
              {selectedSession?.isCurrentSession
                ? 'Same live Q ↔ Mister session.'
                : 'Fallback to the freshest visible live session.'}
            </p>
            <p className="muted mono">{selectedSession?.sessionKey ?? snapshot.primarySessionKey ?? 'unknown'}</p>
          </div>
          <div className="queue-toolbar compact-launcher-actions">
            <button className="button-primary" type="button" onClick={() => setSelectedId(selectedSession?.id ?? '')}>
              Focus session
            </button>
            <button type="button" onClick={() => setOperatorOpen((current) => !current)}>
              {operatorOpen ? 'Hide tools' : 'Open tools'}
            </button>
          </div>
        </div>
      </section>

      {selectedSession && operatorOpen ? <SessionOperatorPanel agent={selectedSession} compact /> : null}
    </div>
  );
}
