/**
 * controller.ts — Re-exports from domain-split controller files.
 *
 * Split into:
 *   controller-sync.ts    — Data fetching (sync, inbox, history, review)
 *   controller-compose.ts — Compose/submit (attachments, enhance, steer, resume)
 *   controller-actions.ts — Surface actions (run, disposition, copy, refresh, focus, stop, diff)
 */

export {
  mobileSyncOnce,
  refreshInboxSnapshot,
  loadSessionHistory,
  loadMoreHistory,
  loadOwnedReviewPacketForSession,
  loadReviewFilePreview,
} from './controller-sync';

export {
  prepareImageAttachments,
  removeImageAttachment,
  enhancePromptDraft,
  submitSteerTurn,
  loadOwnedCorrectionDraftForSession,
  submitOwnedResumeTurn,
} from './controller-compose';

export {
  runMobileAction,
  setOwnedReviewDispositionOptimistically,
  updateOwnedReviewDisposition,
  copyTextToClipboard,
  refreshMobileSurface,
  focusSessionSurface,
  stopActiveRunFromSurface,
  openDiffViewerForSession,
} from './controller-actions';
