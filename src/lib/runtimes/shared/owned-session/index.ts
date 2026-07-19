/**
 * Barrel export for the owned-session primitive.
 *
 * Consumers should import from `@/lib/runtimes/shared/owned-session` rather
 * than reaching into the individual files — the internal split may evolve.
 */

export type {
  OwnedRunMode,
  OwnedRunOutcome,
  OwnedReviewDisposition,
  OwnedSessionState,
  OwnedChildExitOutcome,
  OwnedRunRecord,
  OwnedSessionRecord,
  OwnedTailEntry,
  OwnedTailGroup,
  ParsedRunLog,
  OwnedRunEvidence,
  OwnedFleetAdditions,
  OwnedCodexFleetAdditions,
  OwnedLaunchRequest,
  OwnedLaunchResponse,
  OwnedArchiveResponse,
  OwnedRuntimeAdapter,
  OwnedSessionStore,
} from './types';

export { createOwnedSessionStore } from './store';
export {
  createDeclarativeOwnedRuntimeAdapter,
  getDeclarativeOwnedRuntime,
  registerDeclarativeOwnedRuntime,
  renderDeclarativeArgs,
} from './declarative-adapter';
export type {
  DeclarativeArgGroup,
  DeclarativeArgTemplate,
  DeclarativeOwnedRuntimeConfig,
  DeclarativeOwnedRuntimeRegistration,
  DeclarativeRunLogPattern,
  DeclarativeRunLogPatterns,
} from './declarative-adapter';

// Re-exported helpers for adapters that need to share the text-compaction /
// clock-formatting conventions with the store.
export {
  compactText,
  formatClock,
  previewText,
  relativeAge,
  shortHome,
} from './helpers';
