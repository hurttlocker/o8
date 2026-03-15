import { Menu, SlidersHorizontal } from 'lucide-react';
import type { TopBarProps } from './types';

export function TopBar({
  snapshot,
  selectedSession,
  selectedReviewPacket,
  selectedReviewFile,
  reviewFiles,
  isOwnedCodexSession,
  isHeaderCompact,
  headerVisible,
  pendingApprovalsCount,
  wsConnectionState,
  compactLine,
  onOpenControls,
  onOpenDiff,
}: TopBarProps) {
  const connectionDotColor = wsConnectionState === 'connected'
    ? '#34c759'
    : wsConnectionState === 'connecting'
      ? '#ff9f0a'
      : '#ff3b30';
  const totalAdditions = reviewFiles.reduce((sum, file) => sum + (file.additions ?? 0), 0);
  const totalDeletions = reviewFiles.reduce((sum, file) => sum + (file.deletions ?? 0), 0);
  const focusedAdditions = selectedReviewFile?.additions ?? totalAdditions;
  const focusedDeletions = selectedReviewFile?.deletions ?? totalDeletions;
  const diffFileLabel = reviewFiles.length === 1 ? 'file' : 'files';
  const activeTitle = compactLine(
    isOwnedCodexSession
      ? selectedReviewPacket?.title ?? selectedSession?.name ?? selectedSession?.currentTask
      : snapshot.review?.pullRequest?.title ?? selectedSession?.name ?? selectedSession?.currentTask,
    selectedSession?.isCurrentSession ? 'Q ↔ Mister live' : selectedSession?.name ?? 'Current session',
    26,
  );
  const activeSubtitle = compactLine(
    isOwnedCodexSession
      ? (selectedReviewPacket?.repoSlug && selectedReviewPacket?.branch ? `/${selectedReviewPacket.repoSlug}/${selectedReviewPacket.branch}` : selectedSession?.sessionKey)
      : (snapshot.review ? `/${snapshot.review.repoSlug}/${snapshot.review.branch}` : selectedSession?.sessionKey),
    selectedSession?.sessionKey ?? 'mobile/live',
    42,
  );
  const headerLabel = isOwnedCodexSession
    ? (selectedSession?.runtimeSurface?.capabilities.interrupt ? 'Codex live' : selectedSession?.runtimeSurface?.capabilities.sendInput ? 'Codex chat' : 'Codex watch')
    : selectedSession?.runtime === 'codex'
      ? 'Codex'
      : selectedSession?.status === 'running'
        ? 'Live'
        : snapshot.review?.pullRequest
          ? 'Review'
          : 'Session';

  return (
    <header
      className="remodex-topbar"
      data-compact={isHeaderCompact ? 'true' : 'false'}
      data-context-visible="false"
      data-visible={headerVisible ? 'true' : 'false'}
    >
      <div style={{ position: 'relative', flexShrink: 0 }}>
        <button
          type="button"
          className="remodex-circle-button"
          aria-label="Conversation controls"
          onClick={onOpenControls}
          style={{ background: '#ef4444', color: '#ffffff', border: 'none', boxShadow: '0 4px 12px rgba(239,68,68,0.25)' }}
        >
          <Menu size={18} strokeWidth={2.1} />
        </button>
        {pendingApprovalsCount > 0 ? (
          <span className="remodex-approval-badge">{pendingApprovalsCount}</span>
        ) : null}
      </div>
      <div className="remodex-title-shell" style={{ minWidth: 0, flex: 1 }}>
        <div className="remodex-title-stack">
          <span className="remodex-title-kicker">
            <span
              style={{
                display: 'inline-block',
                width: '6px',
                height: '6px',
                borderRadius: '50%',
                backgroundColor: connectionDotColor,
                marginRight: '5px',
                verticalAlign: 'middle',
              }}
              title={`WebSocket: ${wsConnectionState ?? 'unknown'}`}
            />
            {headerLabel}
          </span>
          <h1>{activeTitle}</h1>
          <p>{activeSubtitle}</p>
        </div>
      </div>
      <button
        type="button"
        className="remodex-diff-pill"
        onClick={onOpenDiff}
        disabled={!reviewFiles.length}
        style={{ flexShrink: 0 }}
        aria-label={`Open diff sheet with +${focusedAdditions ?? 0}, -${focusedDeletions ?? 0}, ${reviewFiles.length} ${diffFileLabel}`}
      >
        <span className="remodex-diff-pill-stats" aria-hidden="true">
          <span className="remodex-diff-pill-chip remodex-diff-pill-chip-add">+{focusedAdditions ?? 0}</span>
          <span className="remodex-diff-pill-chip remodex-diff-pill-chip-remove">-{focusedDeletions ?? 0}</span>
        </span>
        <span className="remodex-diff-pill-meta">
          <span className="remodex-diff-pill-count">{reviewFiles.length}</span>
          <span className="remodex-diff-pill-caption">{diffFileLabel}</span>
        </span>
        <SlidersHorizontal size={15} strokeWidth={2} />
      </button>
    </header>
  );
}
