// Voice Operator — the UI-agnostic intent contract.
// Shared vocabulary for desktop (and later mobile + CLI/MCP via harness epic #1204).
// No deps, no I/O — just the shared voice-intent types.

/**
 * The canonical conductor verb set. Voice speaks these; the headless CLI + MCP
 * (harness #1204 Phase 0) share the same vocabulary so voice never becomes a
 * parallel action plane.
 */
export type ConductorVerb =
  | 'ground'
  | 'dispatch'
  | 'review'
  | 'approve'
  | 'reject'
  | 'reset'
  | 'ask'
  | 'switch-surface'
  | 'set-mode';

/**
 * Irreversible verbs that ALWAYS require a two-utterance spoken-confirm before
 * executing, regardless of confidence — auto-dispatch never bypasses this.
 * ('dispatch' to the main branch is treated as irreversible via the target check.)
 */
export const IRREVERSIBLE_VERBS: readonly ConductorVerb[] = [
  'approve',
  'reject',
  'reset',
] as const;

export type IntentKind =
  // a deterministic conductor verb (high-confidence; may auto-execute)
  | 'command'
  // a spoken task for the conductor brain (reversible; auto-dispatch when confident)
  | 'brief'
  // an ungated OS convenience action (open app, reminder) — a separate plane that
  // MUST NOT touch the governed code-dispatch/review/merge surface
  | 'mac-action'
  // ambiguous / low-confidence — the conductor must read back candidates and ask
  | 'clarify';

export interface IntentTarget {
  /** repo path, packet id, PR number, lane id, or app/url (for mac-actions). */
  readonly ref?: string;
  /** human label resolved against live inventory (repos / lanes / PRs). */
  readonly label?: string;
  /** when >1 candidate matched, the options the conductor reads back. */
  readonly candidates?: readonly { ref: string; label: string }[];
}

export interface IntentResult {
  readonly kind: IntentKind;
  /** the conductor verb when kind === 'command'. */
  readonly verb?: ConductorVerb;
  /**
   * 0..1 intent-routing confidence (fuzzy-match of the target vs live inventory).
   * NOT the STT/second-pass transcription score — those are distinct.
   */
  readonly confidence: number;
  /** resolved target or candidate set. */
  readonly target?: IntentTarget;
  /** the raw (polished) utterance text. */
  readonly text: string;
  /** true when this intent must pass the two-utterance spoken-confirm first. */
  readonly requiresConfirm: boolean;
}

/**
 * Confidence at/above which a reversible brief or command may auto-execute
 * without a fill-and-review pause. Tunable. Irreversible verbs ignore this.
 */
export const AUTO_DISPATCH_THRESHOLD = 0.85;
