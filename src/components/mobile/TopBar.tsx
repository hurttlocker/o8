import { memo } from 'react';
import { ChevronRight, MoreHorizontal } from 'lucide-react';
import type { TopBarProps } from './types';
import { SpeedDialButton } from './SpeedDial';
import { MobileChromeButton } from './ReferencePrimitives';

function screenTitle(activeView: TopBarProps['activeView']) {
  switch (activeView) {
    case 'fleet':
      return 'Agents';
    case 'memory':
      return 'Memory';
    case 'activity':
      return 'Activity';
    case 'settings':
      return 'Settings';
    case 'issues':
      return 'Issues';
    case 'costs':
      return 'Costs';
    default:
      return 'Code';
  }
}

export const TopBar = memo(function TopBar({
  selectedSession,
  headerVisible,
  pendingApprovalsCount,
  activeView,
  compactLine,
  activeScreen,
  onNavigate,
  onBackToIndex,
  onOpenControls,
}: TopBarProps) {
  if (activeView !== 'squad' && activeView !== 'chat') {
    return null;
  }

  const isThreadView = activeView === 'chat';
  const threadTitle = compactLine(
    selectedSession?.currentTask ?? selectedSession?.name,
    selectedSession?.name ?? 'Code',
    30,
  );

  return (
    <>
      <div className="remodex-reference-top-veil" aria-hidden="true" />
      <header
        className={`remodex-reference-header${isThreadView ? ' remodex-reference-header-thread' : ' remodex-reference-header-index'}`}
        style={{
          opacity: headerVisible ? 1 : 0,
          transform: headerVisible ? 'translateY(0)' : 'translateY(-10px)',
        }}
      >
        {isThreadView ? (
            <MobileChromeButton label="Back to code list" onClick={onBackToIndex}>
            <ChevronRight size={18} strokeWidth={2} style={{ transform: 'rotate(180deg)' }} />
          </MobileChromeButton>
        ) : (
          <SpeedDialButton
            activeScreen={activeScreen}
            onNavigate={onNavigate}
            approvalCount={pendingApprovalsCount}
          />
        )}

        <div className="remodex-reference-header-copy">
          <h1>{isThreadView ? threadTitle : screenTitle(activeView)}</h1>
          {isThreadView ? <p>Remote control</p> : null}
        </div>

        {isThreadView ? (
          <MobileChromeButton label="Open thread controls" onClick={onOpenControls}>
            <MoreHorizontal size={18} strokeWidth={2} />
          </MobileChromeButton>
        ) : (
          <span className="remodex-reference-header-spacer" aria-hidden="true" />
        )}
      </header>
    </>
  );
});
