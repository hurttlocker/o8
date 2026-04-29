'use client';

/**
 * #746 / #748 — Hook that owns directive-proposal state for
 * `ThoughtsMissionPanel`. Fetches BOTH proposal sources (auto + cross-repo)
 * in parallel and merges them into a single yellow-row list. Pulled out of
 * the panel so the panel stays under the 800-line ceiling.
 *
 * Responsibilities:
 *   - Fetch the cached proposal sets from `/api/cortex/proposals` (#746)
 *     and `/api/cortex/cross-repo-proposals` (#748) on panel-open,
 *     lifecycle events, and a 5-min fallback poll.
 *   - Hide a row optimistically while the dismiss POST is in flight.
 *   - Route dismiss to the correct endpoint based on `proposal.source`.
 *   - Dispatch Accept by calling `onAccept` with the candidate; the
 *     consumer (Mission panel) wires it to the orchestrator chat composer
 *     via `OrchestratorDataContext.onAcceptDirectiveProposal`.
 */

import { useCallback, useEffect, useState } from 'react';
import type {
  AutoDirectiveProposal,
  CrossRepoDirectiveProposal,
  DirectiveProposalCandidate,
} from '../directive-proposal-types';

interface UseDirectiveProposalsArgs {
  open: boolean;
  visible: boolean;
  /** Bumped by the parent's existing retry button — re-trigger the fetch alongside issues. */
  retryNonce: number;
  /**
   * Called when the operator clicks Accept. The Mission panel wires this
   * to the orchestrator chat composer via the OrchestratorData context.
   */
  onAccept: (proposal: DirectiveProposalCandidate) => void;
}

interface UseDirectiveProposalsReturn {
  proposals: DirectiveProposalCandidate[];
  pendingProposalId: string | null;
  handleAccept: (proposal: DirectiveProposalCandidate) => void;
  handleDismiss: (proposal: DirectiveProposalCandidate) => Promise<void>;
}

// Server returns these as plain JSON without a discriminator stamped on
// every record (the `source` field was added in #748). We tag them at the
// fetch boundary so the row component can branch on `proposal.source`
// safely even if the cache predates the field.
type RawAutoProposal = Omit<AutoDirectiveProposal, 'source'> & { source?: 'auto' };
type RawCrossRepoProposal = Omit<CrossRepoDirectiveProposal, 'source'> & { source?: 'cross-repo' };

export function useDirectiveProposals({
  open,
  visible,
  retryNonce,
  onAccept,
}: UseDirectiveProposalsArgs): UseDirectiveProposalsReturn {
  const [proposals, setProposals] = useState<DirectiveProposalCandidate[]>([]);
  const [pendingProposalId, setPendingProposalId] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !visible) return;
    let cancelled = false;
    const loadProposals = async () => {
      try {
        const [autoRes, crossRes] = await Promise.allSettled([
          fetch('/api/cortex/proposals', { cache: 'no-store' }),
          fetch('/api/cortex/cross-repo-proposals', { cache: 'no-store' }),
        ]);
        if (cancelled) return;

        const merged: DirectiveProposalCandidate[] = [];

        if (autoRes.status === 'fulfilled' && autoRes.value.ok) {
          try {
            const data = (await autoRes.value.json()) as { ok?: boolean; proposals?: RawAutoProposal[] };
            if (!cancelled && data?.ok && Array.isArray(data.proposals)) {
              for (const p of data.proposals) {
                merged.push({ ...p, source: 'auto' } as AutoDirectiveProposal);
              }
            }
          } catch (err) {
            console.warn('[proposer] auto parse failed:', err instanceof Error ? err.message : err);
          }
        }

        if (crossRes.status === 'fulfilled' && crossRes.value.ok) {
          try {
            const data = (await crossRes.value.json()) as { ok?: boolean; proposals?: RawCrossRepoProposal[] };
            if (!cancelled && data?.ok && Array.isArray(data.proposals)) {
              for (const p of data.proposals) {
                merged.push({ ...p, source: 'cross-repo' } as CrossRepoDirectiveProposal);
              }
            }
          } catch (err) {
            console.warn('[proposer] cross-repo parse failed:', err instanceof Error ? err.message : err);
          }
        }

        if (!cancelled) setProposals(merged);
      } catch (err) {
        console.warn('[proposer] proposal fetch failed:', err instanceof Error ? err.message : err);
      }
    };
    void loadProposals();
    // Re-poll on the same lifecycle events the issue panel listens for —
    // dispatch + lane lifecycle is when new outcomes land.
    const handler = () => { void loadProposals(); };
    const events = ['o8:lane-lifecycle', 'o8:agent-lifecycle'];
    for (const e of events) window.addEventListener(e, handler);
    const fallbackId = setInterval(handler, 5 * 60 * 1000); // 5 min UI poll
    return () => {
      cancelled = true;
      clearInterval(fallbackId);
      for (const e of events) window.removeEventListener(e, handler);
    };
  }, [open, visible, retryNonce]);

  const handleAccept = useCallback((proposal: DirectiveProposalCandidate) => {
    onAccept(proposal);
    // #855 — Cross-repo Accept stamps directive origin in the sidecar map
    // so the next 30-min tick won't propose D back to its source. Fire and
    // forget — the orchestrator chat-composer handoff is the user-visible
    // path; this just records provenance. Failure is non-fatal (worst case
    // we'd see a circular re-proposal once, then the operator dismisses).
    if (proposal.source === 'cross-repo') {
      void fetch('/api/cortex/cross-repo-proposals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'accept',
          directiveId: proposal.directiveId,
          originRepoId: proposal.sourceRepoId,
        }),
      }).catch((err) => {
        console.warn('[proposer] origin stamp failed:', err instanceof Error ? err.message : err);
      });
    }
    // Hide the row locally — once a directive is created, the next tick
    // will (eventually) shift the file/fix patterns enough that the
    // proposer stops re-emitting it. If not, the operator can re-dismiss.
    setProposals((current) => current.filter((p) => p.id !== proposal.id));
  }, [onAccept]);

  const handleDismiss = useCallback(async (proposal: DirectiveProposalCandidate) => {
    setPendingProposalId(proposal.id);
    try {
      let res: Response;
      if (proposal.source === 'cross-repo') {
        res = await fetch('/api/cortex/cross-repo-proposals', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'dismiss',
            targetRepoId: proposal.targetRepoId,
            directiveId: proposal.directiveId,
          }),
        });
      } else {
        res = await fetch('/api/cortex/proposals', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'dismiss',
            id: proposal.id,
            filePattern: proposal.filePattern,
            fixPattern: proposal.fixPattern,
          }),
        });
      }
      const data = (await res.json().catch(() => null)) as { ok?: boolean } | null;
      if (!res.ok || !data?.ok) {
        console.warn('[proposer] dismiss failed', data);
      }
      setProposals((current) => current.filter((p) => p.id !== proposal.id));
    } catch (err) {
      console.warn('[proposer] dismiss request threw:', err instanceof Error ? err.message : err);
    } finally {
      setPendingProposalId(null);
    }
  }, []);

  return { proposals, pendingProposalId, handleAccept, handleDismiss };
}
