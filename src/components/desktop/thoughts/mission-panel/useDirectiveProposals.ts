'use client';

/**
 * #746 — Hook that owns the auto-directive proposer state for
 * `ThoughtsMissionPanel`. Pulled out of the panel so the panel stays under
 * the 800-line ceiling.
 *
 * Responsibilities:
 *   - Fetch the cached proposal set from `/api/cortex/proposals` on
 *     panel-open + lifecycle events + 5-min fallback poll.
 *   - Hide a row optimistically while the dismiss POST is in flight.
 *   - Dispatch Accept by calling `onAccept` with the candidate; the
 *     consumer (Mission panel) wires it to the orchestrator chat composer
 *     via `OrchestratorDataContext.onAcceptDirectiveProposal`.
 */

import { useCallback, useEffect, useState } from 'react';
import type { DirectiveProposalCandidate } from '../directive-proposal-types';

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
        const res = await fetch('/api/cortex/proposals', { cache: 'no-store' });
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { ok?: boolean; proposals?: DirectiveProposalCandidate[] };
        if (cancelled) return;
        if (data?.ok && Array.isArray(data.proposals)) {
          setProposals(data.proposals);
        }
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
    // Hide the row locally — once a directive is created, the next tick
    // will (eventually) shift the file/fix patterns enough that the
    // proposer stops re-emitting it. If not, the operator can re-dismiss.
    setProposals((current) => current.filter((p) => p.id !== proposal.id));
  }, [onAccept]);

  const handleDismiss = useCallback(async (proposal: DirectiveProposalCandidate) => {
    setPendingProposalId(proposal.id);
    try {
      const res = await fetch('/api/cortex/proposals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'dismiss',
          id: proposal.id,
          filePattern: proposal.filePattern,
          fixPattern: proposal.fixPattern,
        }),
      });
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
