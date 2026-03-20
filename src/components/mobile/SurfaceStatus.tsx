import { memo } from 'react';
import type { SurfaceStatusProps } from './types';
import { sessionStatusSummary } from './utils';

export const SurfaceStatus = memo(function SurfaceStatus({
  selectedSession,
  selectedReviewPacket,
  isOwnedCodexSession,
  refreshError,
  surfaceNote,
  transcriptError,
  selectedReviewPacketError,
}: SurfaceStatusProps) {
  const status = sessionStatusSummary(selectedSession, selectedReviewPacket, isOwnedCodexSession);
  const notices = [refreshError, surfaceNote, transcriptError, selectedReviewPacketError].filter(Boolean);

  return (
    <>
      {selectedSession?.activity && selectedSession.status !== 'idle' ? (
        <div className="remodex-activity-bar">
          <span className="remodex-activity-dot" />
          <span className="remodex-activity-label">{selectedSession.activity.headline}</span>
          {selectedSession.activity.filePath ? (
            <span className="remodex-activity-file">{selectedSession.activity.filePath.split('/').pop()}</span>
          ) : null}
        </div>
      ) : null}

      {status.tone !== 'calm' ? (
        <div className={`remodex-context-system-msg remodex-context-system-msg-${status.tone}`}>
          <span className="remodex-context-system-dot" />
          <span>{status.headline} · {status.meta}</span>
        </div>
      ) : null}

      {notices.map((notice, index) => (
        <p key={`${index}:${notice}`} className="remodex-banner-note">{notice}</p>
      ))}
    </>
  );
});
