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
  const [expandedSessionKey, setExpandedSessionKey] = useState<string | null>(initialSnapshot.primarySessionKey ?? null);
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

      <section className="mobile-grid">
        <div className="surface-card mobile-card">
          <span>Mode</span>
          <strong>{snapshot.mode === 'live' ? 'Live control' : 'Demo fallback'}</strong>
          <p>{snapshot.note ?? 'Mobile is reading a control snapshot, not talking to one vendor runtime directly.'}</p>
        </div>
        <div className="surface-card mobile-card">
          <span>Primary session</span>
          <strong>{selectedSession?.name ?? 'Unknown'}</strong>
          <p>{selectedSession?.sessionKey ?? snapshot.primarySessionKey ?? 'No live session visible.'}</p>
        </div>
      </section>

      <section className="mobile-grid">
        <div className="surface-card mobile-card">
          <span>Active runs</span>
          <strong>{snapshot.summary.activeRuns}</strong>
          <p>Running, blocked, and review-warm sessions that may need attention tonight.</p>
        </div>
        <div className="surface-card mobile-card">
          <span>Alerts</span>
          <strong>{snapshot.summary.alerts}</strong>
          <p>Critical or warning items surfaced into the phone inbox instead of hiding in the desktop shell.</p>
        </div>
      </section>

      <section className="mobile-grid">
        <div className="surface-card mobile-card">
          <span>Approvals</span>
          <strong>{snapshot.summary.approvals}</strong>
          <p>Contract supports them; OpenClaw-backed approval handling is still a truthful future lane.</p>
        </div>
        <div className="surface-card mobile-card">
          <span>Review items</span>
          <strong>{snapshot.summary.reviewItems}</strong>
          <p>Desktop review stays heavy, but phone now knows when review-ready work exists.</p>
        </div>
      </section>

      <section className="surface-card">
        <div className="section-head">
          <div>
            <div className="eyebrow">Inbox</div>
            <h2>Live operator queue</h2>
          </div>
          <span className={`status-pill ${refreshError ? 'status-warning' : 'status-success'}`}>
            {refreshError ? 'refresh warning' : 'live inbox'}
          </span>
        </div>
        {actionHint ? <p className="muted operator-note">{actionHint}</p> : null}
        <div className="mobile-stack">
          {snapshot.items.map((item) => {
            const sessionKey = item.sessionKey;
            const inlineHistory = sessionKey ? historyBySession[sessionKey] ?? [] : [];
            const inlineHistoryError = sessionKey ? historyError[sessionKey] : null;
            const inlineHistoryLoading = sessionKey ? historyLoading[sessionKey] : false;
            const inlineActionState = sessionKey ? actionStateBySession[sessionKey] ?? 'idle' : 'idle';
            const inlineActionNote = sessionKey ? actionNoteBySession[sessionKey] : null;
            const inlineDraft = sessionKey ? draftBySession[sessionKey] ?? '' : '';
            const historyOpen = Boolean(sessionKey && expandedSessionKey === sessionKey);
            const composeOpen = Boolean(sessionKey && composeSessionKey === sessionKey);

            return (
              <div key={item.id} className="mobile-action-card">
                <div className="row space-between compact-row">
                  <div>
                    <h3>{item.title}</h3>
                    <p>{item.detail}</p>
                  </div>
                  <span className={`status-pill ${statusClass(item.severity)}`}>{item.kind.replace('_', ' ')}</span>
                </div>
                <p className="muted mono">{item.timestampLabel ?? 'now'}</p>
                <div className="tool-drawer-list tool-drawer-list-mobile">
                  {item.actions.map((action) => (
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

                {composeOpen && sessionKey ? (
                  <div className="inset-card">
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
                  <div className="inset-card">
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
                      <div className="transcript-list top-gap">
                        {inlineHistory.map((entry) => (
                          <div key={entry.id} className="transcript-entry">
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
      </section>

      {snapshot.review ? (
        <section className="surface-card mobile-review-focus">
          <div className="section-head">
            <div>
              <div className="eyebrow">Review focus</div>
              <h2>Deeper than a desktop link</h2>
            </div>
            <span className={`status-pill ${statusClass(snapshot.review.changedFiles.length ? 'reviewing' : 'healthy')}`}>
              {snapshot.review.changedFiles.length ? `${snapshot.review.changedFiles.length} files` : 'review clean'}
            </span>
          </div>

          <div className="mobile-review-headline">
            <div>
              <span>Current lane</span>
              <strong>
                {snapshot.review.pullRequest
                  ? `PR #${snapshot.review.pullRequest.number} — ${snapshot.review.pullRequest.title}`
                  : snapshot.review.branch}
              </strong>
              <p className="muted mono">{snapshot.review.branch}</p>
            </div>
            <div className="glass-link-row">
              <Link href={snapshot.review.desktopHref} className="mobile-action-link">
                Review stack ↗
              </Link>
              {snapshot.review.pullRequest ? (
                <a href={snapshot.review.pullRequest.url} target="_blank" rel="noreferrer" className="mobile-action-link">
                  GitHub PR ↗
                </a>
              ) : null}
            </div>
          </div>

          {snapshot.review.issues.length ? (
            <div className="glass-chip-grid">
              {snapshot.review.issues.map((issue) => (
                <a key={issue.number} href={issue.url} target="_blank" rel="noreferrer" className="glass-chip">
                  {`#${issue.number} • ${issue.title}`}
                </a>
              ))}
            </div>
          ) : null}

          {snapshot.review.changedFiles.length ? (
            <>
              <p className="muted operator-note">
                Tap a file to inspect the local diff inline before you drop into the heavier desktop review surface.
              </p>
              <div className="glass-file-list">
                {snapshot.review.changedFiles.map((file) => {
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
                      className={`glass-file-row glass-file-button ${isSelected ? 'glass-file-row-active' : ''}`}
                      onClick={() => {
                        void handleReviewFileSelect(file.path);
                      }}
                    >
                      <div className="row space-between compact-row">
                        <strong className="mono">{file.path}</strong>
                        <span className={`status-pill ${statusClass(fileTone)}`}>
                          {file.status}
                        </span>
                      </div>
                      <p className="muted mono">
                        +{file.additions ?? 0} / -{file.deletions ?? 0}
                      </p>
                      <span className="glass-file-caption">
                        {isSelected ? 'Hide preview' : 'Open file preview'}
                      </span>
                    </button>
                  );
                })}
              </div>
            </>
          ) : null}

          {selectedReviewFilePath ? (
            <div className="glass-review-preview inset-card">
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
                  <p className="muted operator-note">{reviewFileByPath[selectedReviewFilePath].note}</p>
                  <pre className="glass-diff-preview">{reviewFileByPath[selectedReviewFilePath].preview}</pre>
                </>
              ) : reviewFileLoadingPath === selectedReviewFilePath ? (
                <p className="muted operator-note">Loading per-file review preview…</p>
              ) : (
                <p className="muted operator-note">No inline review preview is cached for this file yet.</p>
              )}
            </div>
          ) : null}

          {snapshot.review.diffStat ? (
            <pre className="glass-diff-preview">
              {snapshot.review.diffStat.split('\n').filter(Boolean).slice(0, 6).join('\n')}
            </pre>
          ) : null}
        </section>
      ) : null}

      <section className="surface-card">
        <div className="section-head">
          <div>
            <div className="eyebrow">Current session truth</div>
            <h2>Mirrored session first</h2>
          </div>
        </div>
        <div className="mobile-memory-card">
          <div>
            <strong>{selectedSession?.name ?? 'No current session'}</strong>
            <p className="muted">
              {selectedSession?.isCurrentSession
                ? 'This is the same Q ↔ Mister session you are actively talking in right now.'
                : 'The phone fell back to the freshest visible session from the live control snapshot.'}
            </p>
            <p className="muted mono">{selectedSession?.sessionKey ?? snapshot.primarySessionKey ?? 'unknown'}</p>
          </div>
          <button className="button-primary" type="button" onClick={() => setSelectedId(selectedSession?.id ?? '')}>
            Operate this session
          </button>
        </div>
      </section>

      {selectedSession ? <SessionOperatorPanel agent={selectedSession} compact /> : null}
    </div>
  );
}
