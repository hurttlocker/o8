'use client';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { LINKED_PR_CHANGE_EVENT, linkedPrIdentity, readLinkedPullRequests, saveLinkedPullRequests, type LinkedPullRequest } from './linked-pr-store';
const EMPTY: LinkedPullRequest[] = [];
function subscribe(listener: () => void) {
  window.addEventListener(LINKED_PR_CHANGE_EVENT, listener);
  window.addEventListener('storage', listener);
  return () => { window.removeEventListener(LINKED_PR_CHANGE_EVENT, listener); window.removeEventListener('storage', listener); };
}

export function useLinkedPullRequests(context: string, tabId: string | null) {
  const links = useSyncExternalStore(subscribe, useCallback(() => readLinkedPullRequests(context), [context]), () => EMPTY);
  const [recovery, setRecovery] = useState<{ context: string; links: LinkedPullRequest[]; error: string } | null>(null);
  const previous = useRef({ context, tabId });
  useEffect(() => {
    const prev = previous.current;
    // The first turn assigns a history id. Carry this fresh tab's links into its durable conversation.
    if (tabId && prev.tabId === tabId && prev.context.startsWith('tab:') && context.startsWith('thread:')) {
      const existing = readLinkedPullRequests(context);
      const migrated = [...existing, ...readLinkedPullRequests(prev.context).filter((link) => !existing.some((entry) => linkedPrIdentity(entry) === linkedPrIdentity(link)))];
      if (migrated.length !== existing.length) {
        try {
          if (migrated.length > 50) throw new Error('The conversation has too many links.');
          saveLinkedPullRequests(context, migrated);
        } catch {
          // Preserve visible links if external storage cannot accept the history handoff.
          setRecovery({ context, links: migrated, error: 'Linked PRs could not be saved to this conversation. Their original tab links are retained.' });
        }
      }
    }
    previous.current = { context, tabId };
  }, [context, tabId]);
  const link = (entry: LinkedPullRequest) => {
    const current = recovery?.context === context ? recovery.links : readLinkedPullRequests(context);
    const same = current.some((item) => linkedPrIdentity(item) === linkedPrIdentity(entry));
    if (!same && current.length >= 50) throw new Error('This conversation already has 50 linked pull requests.');
    saveLinkedPullRequests(context, same ? current.map((item) => linkedPrIdentity(item) === linkedPrIdentity(entry) ? entry : item) : [...current, entry]);
    setRecovery(null);
  };
  const unlink = (entry: LinkedPullRequest) => {
    const current = recovery?.context === context ? recovery.links : readLinkedPullRequests(context);
    const remaining = current.filter((item) => linkedPrIdentity(item) !== linkedPrIdentity(entry));
    if (remaining.length > 50) {
      setRecovery({ context, links: remaining, error: 'Remove more links to save this conversation. The original tab links are retained.' });
      return;
    }
    saveLinkedPullRequests(context, remaining);
    setRecovery(null);
  };
  return { links: recovery?.context === context ? recovery.links : links, link, unlink, persistenceError: recovery?.context === context ? recovery.error : null };
}
