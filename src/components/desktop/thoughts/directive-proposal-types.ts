/**
 * #746 — Client-side type for the auto-directive proposer.
 *
 * Mirrors `DirectiveProposalCandidate` in `src/lib/cortex/proposer.ts`.
 * Duplicated here because that module is `'server-only'` and the
 * Mission panel runs in the browser. Keep the shapes in sync.
 */

export interface DirectiveProposalCandidate {
  id: string;
  filePattern: string;
  fixPattern: string;
  hits: number;
  lastSeenAt: string;
  outcomeIds: string[];
  draftDirective: string;
}
