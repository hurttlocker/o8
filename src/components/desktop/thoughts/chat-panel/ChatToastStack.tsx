/**
 * Small stack of transient notices that render between ChatMessageList and
 * ComposerArea: the orchestrator reload banner and the clear-thread toast.
 * Extracted from ThoughtsChatPanel to keep that file from growing further
 * above the 800-line ceiling.
 *
 * Inline styles only per the repo's no-CSS-classes rule.
 */
'use client';

import { ClearToast } from './ClearToast';
import { ReloadBanner } from './ReloadBanner';
import type { OrchestratorReloadNotice } from './useOrchestratorReloadNotice';

export interface ChatToastStackProps {
  reloadNotice: OrchestratorReloadNotice | null;
  onDismissReloadNotice: () => void;
  showClearToast: boolean;
  /** Phase 4 friction fix #1: tab-refocus draft auto-clear toast. */
  showDraftClearedToast?: boolean;
  thoughtsBodyBackground: string;
}

export function ChatToastStack(props: ChatToastStackProps) {
  const {
    reloadNotice,
    onDismissReloadNotice,
    showClearToast,
    showDraftClearedToast = false,
    thoughtsBodyBackground,
  } = props;

  if (!reloadNotice && !showClearToast && !showDraftClearedToast) return null;

  return (
    <>
      {reloadNotice ? (
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            paddingTop: 0,
            paddingRight: 12,
            paddingBottom: 6,
            paddingLeft: 12,
            background: thoughtsBodyBackground,
            flexShrink: 0,
          }}
        >
          <ReloadBanner
            noticeId={reloadNotice.noticeId}
            message={reloadNotice.message}
            detail={reloadNotice.registered.length > 0 ? reloadNotice.registered.join(', ') : undefined}
            autoDismiss={reloadNotice.autoDismiss}
            onDismiss={onDismissReloadNotice}
          />
        </div>
      ) : null}

      {showClearToast ? (
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            paddingTop: 0,
            paddingRight: 12,
            paddingBottom: 8,
            paddingLeft: 12,
            background: thoughtsBodyBackground,
            flexShrink: 0,
            pointerEvents: 'none',
          }}
        >
          <ClearToast />
        </div>
      ) : null}

      {showDraftClearedToast ? (
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            paddingTop: 0,
            paddingRight: 12,
            paddingBottom: 8,
            paddingLeft: 12,
            background: thoughtsBodyBackground,
            flexShrink: 0,
            pointerEvents: 'none',
          }}
        >
          <div
            style={{
              paddingTop: 6,
              paddingRight: 10,
              paddingBottom: 6,
              paddingLeft: 10,
              borderRadius: 10,
              border: '1px solid var(--t-divider-subtle)',
              background: 'var(--t-panel-translucent)',
              color: 'var(--t-text-muted)',
              fontSize: 11,
              fontFamily: '"SF Mono", ui-monospace, monospace',
            }}
          >
            Draft cleared.
          </div>
        </div>
      ) : null}
    </>
  );
}
