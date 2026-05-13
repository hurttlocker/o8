/**
 * #746 / #748 — Client-side types for directive proposals.
 *
 * Two proposal sources share the same `DirectiveProposalRow` chrome:
 *   - `auto` — surfaced by the in-repo auto-proposer (#746). Mirrors
 *     `DirectiveProposalCandidate` in `src/lib/cortex/proposer.ts`.
 *   - `observation` — worker-proposed observations awaiting orchestrator
 *     promotion into a directive / memory entry.
 *   - `cross-repo` — surfaced by the cross-repo learner (#748). When a
 *     directive lands in repo A and ≥ 2 stack-similar repos exist, those
 *     repos see a yellow row offering to import the rule. Mirrors
 *     `CrossRepoProposalCandidate` in `src/lib/cortex/cross-repo-proposer.ts`.
 *
 * Both lib modules are `'server-only'`, so duplicate the shapes here for
 * the browser. Keep them in sync.
 */

export type DirectiveProposalSource = 'auto' | 'observation' | 'cross-repo';

export interface AutoDirectiveProposal {
  source: 'auto';
  id: string;
  filePattern: string;
  fixPattern: string;
  hits: number;
  lastSeenAt: string;
  outcomeIds: string[];
  draftDirective: string;
}

export interface CrossRepoDirectiveProposal {
  source: 'cross-repo';
  id: string;
  /** Repo the operator will see this proposal in. */
  targetRepoId: string;
  targetRepoName: string;
  /** Repo the directive originated from. */
  sourceRepoId: string;
  sourceRepoName: string;
  /** Directive payload. */
  directiveId: string;
  directiveTitle: string;
  directiveBody: string;
  directivePriority: number | null;
  /** Jaccard similarity between source and target (0..1). */
  similarity: number;
  /** Pre-rendered draft text the chat composer fills with on Accept. */
  draftDirective: string;
}

export interface ObservationDirectiveProposal {
  source: 'observation';
  id: string;
  packetId: string;
  laneId: string | null;
  kind: 'regression' | 'pattern' | 'gotcha' | 'preference';
  text: string;
  scope: 'packet' | 'repo' | 'global';
  proposed_by: string;
  createdAt: string;
  draftDirective: string;
}

export type DirectiveProposalCandidate =
  | AutoDirectiveProposal
  | ObservationDirectiveProposal
  | CrossRepoDirectiveProposal;
