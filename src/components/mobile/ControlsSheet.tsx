'use client';

import Link from 'next/link';
import {
  ChevronRight,
  Copy,
  FileDiff,
  Monitor,
  RefreshCw,
  SlidersHorizontal,
  Square,
} from 'lucide-react';
import type { ControlsSheetProps } from './types';
import { UniversalSearch } from '@/components/shared/UniversalSearch';

export function ControlsSheet({
  controlsOpen,
  selectedSession,
  pendingApprovals,
  sessionSwitcher,
  reviewFiles,
  surfaceRefreshing,
  isChatSession,
  isOwnedCodexSession,
  canInterruptOwnedCodex,
  compactLine,
  onClose,
  onRefresh,
  onOpenDiff,
  onToggleApprovals,
  onCopyKey,
  onAbort,
  onSessionFocus,
  onSearchSelectSession,
  onSearchSelectIssue,
  children,
}: ControlsSheetProps) {
  if (!controlsOpen) {
    return null;
  }

  const canAbort = (isChatSession && selectedSession?.status === 'running') || canInterruptOwnedCodex;

  return (
    <div className="remodex-controls-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <section className="remodex-controls-sheet" onClick={(event) => event.stopPropagation()}>
        <div className="remodex-diff-sheet-head remodex-sheet-head-generic">
          <div className="remodex-diff-sheet-handle" />
          <h2>{selectedSession?.isCurrentSession ? 'Q ↔ Mister' : compactLine(selectedSession?.name, 'Session', 24)}</h2>
          <button type="button" className="remodex-done-button remodex-done-tinted" onClick={onClose}>
            Done
          </button>
        </div>

        {/* Universal Search */}
        <div style={{ padding: '0 16px 8px' }}>
          <UniversalSearch
            variant="mobile"
            onSelectSession={(sessionKey) => {
              if (onSearchSelectSession) onSearchSelectSession(sessionKey);
              onClose();
            }}
            onSelectIssue={(num) => {
              if (onSearchSelectIssue) onSearchSelectIssue(num);
              onClose();
            }}
            onSelectFile={() => {
              // File viewing not wired on mobile yet — close menu
              onClose();
            }}
            onClose={onClose}
          />
        </div>

        <div className="remodex-controls-action-list">
          <button
            type="button"
            className="remodex-controls-action-row"
            onClick={() => {
              void onRefresh();
              onClose();
            }}
          >
            <span className="remodex-action-row-icon"><RefreshCw size={18} strokeWidth={1.8} className={surfaceRefreshing ? 'spin' : undefined} /></span>
            <span className="remodex-action-row-label">Refresh</span>
          </button>
          <button type="button" className="remodex-controls-action-row" onClick={onOpenDiff} disabled={!reviewFiles.length}>
            <span className="remodex-action-row-icon"><FileDiff size={18} strokeWidth={1.8} /></span>
            <span className="remodex-action-row-label">Changes</span>
            {reviewFiles.length ? <span className="remodex-action-row-badge">{reviewFiles.length}</span> : null}
          </button>
          <button
            type="button"
            className="remodex-controls-action-row"
            disabled={!selectedSession}
            onClick={() => {
              onCopyKey();
              onClose();
            }}
          >
            <span className="remodex-action-row-icon"><Copy size={18} strokeWidth={1.8} /></span>
            <span className="remodex-action-row-label">Copy session key</span>
          </button>
          <button
            type="button"
            className="remodex-controls-action-row"
            onClick={() => {
              onToggleApprovals();
              onClose();
            }}
          >
            <span className="remodex-action-row-icon"><SlidersHorizontal size={18} strokeWidth={1.8} /></span>
            <span className="remodex-action-row-label">{pendingApprovals.length ? 'Hide demo approvals' : 'Show demo approvals'}</span>
            {pendingApprovals.length ? <span className="remodex-action-row-badge">{pendingApprovals.length}</span> : null}
          </button>
          <Link href="/" className="remodex-controls-action-row remodex-controls-action-link" onClick={onClose}>
            <span className="remodex-action-row-icon"><Monitor size={18} strokeWidth={1.8} /></span>
            <span className="remodex-action-row-label">Open on desktop</span>
            <ChevronRight size={16} strokeWidth={1.8} className="remodex-action-row-chevron" />
          </Link>
          {canAbort ? (
            <button
              type="button"
              className="remodex-controls-action-row remodex-controls-action-row-danger"
              onClick={() => {
                void onAbort();
              }}
            >
              <span className="remodex-action-row-icon"><Square size={18} strokeWidth={1.8} /></span>
              <span className="remodex-action-row-label">{isOwnedCodexSession ? 'Interrupt run' : 'Stop run'}</span>
            </button>
          ) : null}
        </div>

        {/* Cortex Memory status card (passed as children) */}
        {children ? <div style={{ padding: '0 16px', marginTop: 12, marginBottom: 4 }}>{children}</div> : null}

        {sessionSwitcher.length > 1 ? (
          <div className="remodex-controls-session-list">
            <span className="remodex-controls-label">Sessions</span>
            <div className="remodex-controls-session-grid">
              {(() => {
                const nameCount = new Map<string, number>();
                const nameIndex = new Map<string, number>();
                for (const session of sessionSwitcher) {
                  nameCount.set(session.name, (nameCount.get(session.name) ?? 0) + 1);
                }
                return sessionSwitcher.map((session) => {
                  const count = nameCount.get(session.name) ?? 1;
                  const index = (nameIndex.get(session.name) ?? 0) + 1;
                  nameIndex.set(session.name, index);
                  const displayName = session.isCurrentSession
                    ? 'Q ↔ Mister'
                    : count > 1
                      ? `${compactLine(session.name, session.name, 24)} #${index}`
                      : compactLine(session.name, session.name, 32);
                  const active = session.id === selectedSession?.id;
                  const isLive = session.status === 'running' || session.status === 'reviewing';
                  return (
                    <button
                      key={session.id}
                      type="button"
                      className={`remodex-controls-session-row ${active ? 'remodex-controls-session-row-active' : ''}`}
                      onClick={() => onSessionFocus(session.id)}
                    >
                      <span className={`remodex-session-dot ${isLive ? 'remodex-session-dot-live' : ''}`} />
                      <span className="remodex-session-row-copy">
                        <strong>{displayName}</strong>
                        <span>{session.status} · {compactLine(session.lastEventAt, 'now', 20)}</span>
                      </span>
                      {active ? <span className="remodex-session-check">✓</span> : null}
                    </button>
                  );
                });
              })()}
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}
