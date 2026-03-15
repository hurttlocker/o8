import { GitBranch } from 'lucide-react';
import type { RuntimeBarProps } from './types';
import { sessionStatusSummary } from './utils';

export function RuntimeBar({
  snapshot,
  selectedSession,
  selectedReviewPacket,
  isOwnedCodexSession,
  compactLine,
}: RuntimeBarProps) {
  const status = sessionStatusSummary(selectedSession, selectedReviewPacket, isOwnedCodexSession);

  return (
    <div className="remodex-runtime-bar">
      <div className={`remodex-runtime-pressure remodex-runtime-pressure-${status.tone}`}>
        <span className="remodex-pressure-dot" />
        <span className="remodex-pressure-label">{status.headline}</span>
        <span className="remodex-pressure-sep">·</span>
        <GitBranch size={12} strokeWidth={1.6} />
        <span className="remodex-pressure-branch">
          {compactLine(snapshot.review?.branch ?? selectedSession?.branch ?? 'main', 'main', 18)}
        </span>
      </div>
    </div>
  );
}
