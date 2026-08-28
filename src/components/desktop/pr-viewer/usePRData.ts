import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentPanelChatInjectionPayload } from '@/lib/chat/injection';
import { openExternalUrl } from '@/lib/desktop/open-external';
import {
  formatCiCheckInjection,
  formatReviewCommentInjection,
  formatReviewThreadInjection,
} from '@/lib/chat/injection';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import { repoSlugFromRemote } from '../canvas-utils';
import type { PRDetail, ReviewThread, ReviewThreadComment, PRSection, ActionResult } from './types';
import {
  normalizePRDetail,
  normalizeReviewThread,
  normalizeReviewThreads,
  buildReviewThreadStorageKey,
  readPersistedReviewThreadUiState,
  toThreadPreferenceMap,
  requestReviewThreadApi,
} from './shared';

export function usePRData(
  prNumber: number,
  repo: string | undefined,
  onInjectChatContext: ((payload: AgentPanelChatInjectionPayload) => void) | undefined,
) {
  const [pr, setPr] = useState<PRDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [activeSection, setActiveSection] = useState<PRSection>('overview');
  const [activeItemIndex, setActiveItemIndex] = useState(0);
  const [reviewThreads, setReviewThreads] = useState<ReviewThread[]>([]);
  const [reviewsLoading, setReviewsLoading] = useState(false);
  const [reviewThreadsError, setReviewThreadsError] = useState<string | null>(null);
  const [reviewThreadsLoaded, setReviewThreadsLoaded] = useState(false);
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [threadActionLoading, setThreadActionLoading] = useState<Record<string, 'reply' | 'resolve' | 'unresolve'>>({});
  const [viewedThreadIds, setViewedThreadIds] = useState<Record<string, true>>({});
  const [collapsedThreadIds, setCollapsedThreadIds] = useState<Record<string, true>>({});
  const [hydratedReviewThreadStorageKey, setHydratedReviewThreadStorageKey] = useState<string | null>(null);
  const [commentText, setCommentText] = useState('');
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionResult, setActionResult] = useState<ActionResult | null>(null);
  const [addedContextKeys, setAddedContextKeys] = useState<Record<string, true>>({});
  const [hiddenCommentKeys, setHiddenCommentKeys] = useState<Record<string, true>>({});
  const [hoveredCommentKey, setHoveredCommentKey] = useState<string | null>(null);
  const commentInputRef = useRef<HTMLInputElement>(null);
  const [localRepo, setLocalRepo] = useState<Pick<RepoRegistryEntry, 'name' | 'localPath' | 'readiness'> | null>(null);
  const reviewThreadStorageKey = useMemo(() => buildReviewThreadStorageKey(repo, prNumber), [repo, prNumber]);

  /* ---------------------------------------------------------------- */
  /*  Submit action (approve, merge, comment, etc.)                    */
  /* ---------------------------------------------------------------- */

  const submitAction = useCallback(async (action: string, comment?: string) => {
    setActionLoading(action);
    setActionResult(null);
    try {
      const res = await fetch(`/api/panel/prs/${prNumber}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, repo, comment }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Request failed');
      const labels: Record<string, string> = {
        approved: 'PR approved',
        changes_requested: 'Changes requested',
        commented: 'Comment posted',
        merged: 'PR merged',
        closed: 'PR closed',
      };
      setActionResult({ type: 'success', message: labels[data.action] || 'Done' });
      setCommentText('');
      // Refresh PR data
      const repoParam = repo ? `?repo=${encodeURIComponent(repo)}` : '';
      const fresh = await fetch(`/api/panel/prs/${prNumber}${repoParam}`);
      if (fresh.ok) {
        const freshData = await fresh.json();
        setPr(normalizePRDetail(freshData.pr));
      }
    } catch (err) {
      setActionResult({ type: 'error', message: err instanceof Error ? err.message : 'Failed' });
    } finally {
      setActionLoading(null);
    }
  }, [prNumber, repo]);

  /* ---------------------------------------------------------------- */
  /*  Data fetching effects                                            */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setActionResult(null);
    setReviewThreads([]);
    setReviewThreadsError(null);
    setReviewThreadsLoaded(false);
    setReplyDrafts({});
    setThreadActionLoading({});

    const repoParam = repo ? `?repo=${encodeURIComponent(repo)}` : '';
    fetch(`/api/panel/prs/${prNumber}${repoParam}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        if (!cancelled) {
          setPr(normalizePRDetail(data.pr));
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message);
          setLoading(false);
        }
      });

    return () => { cancelled = true; };
  }, [prNumber, repo, reloadNonce]);

  useEffect(() => {
    if (!repo) {
      setLocalRepo(null);
      return;
    }
    let cancelled = false;
    fetch('/api/panel/repos')
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        const match = (data.repos ?? []).find((entry: RepoRegistryEntry) => repoSlugFromRemote(entry.remoteUrl) === repo);
        setLocalRepo(match ? { name: match.name, localPath: match.localPath, readiness: match.readiness } : null);
      })
      .catch(() => {
        if (!cancelled) setLocalRepo(null);
      });
    return () => { cancelled = true; };
  }, [repo]);

  /* ---------------------------------------------------------------- */
  /*  Review thread persistence                                        */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    const persisted = readPersistedReviewThreadUiState(reviewThreadStorageKey);
    setViewedThreadIds(toThreadPreferenceMap(persisted.viewed));
    setCollapsedThreadIds(toThreadPreferenceMap(persisted.collapsed));
    setHydratedReviewThreadStorageKey(reviewThreadStorageKey);
  }, [reviewThreadStorageKey]);

  useEffect(() => {
    if (hydratedReviewThreadStorageKey !== reviewThreadStorageKey || typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(reviewThreadStorageKey, JSON.stringify({
        viewed: Object.keys(viewedThreadIds),
        collapsed: Object.keys(collapsedThreadIds),
      }));
    } catch {
      // Ignore local persistence failures for thread UI preferences.
    }
  }, [collapsedThreadIds, hydratedReviewThreadStorageKey, reviewThreadStorageKey, viewedThreadIds]);

  /* ---------------------------------------------------------------- */
  /*  Review threads fetching                                          */
  /* ---------------------------------------------------------------- */

  const fetchReviewThreads = useCallback(async () => {
    setReviewsLoading(true);
    setReviewThreadsError(null);
    const repoParam = repo ? `&repo=${encodeURIComponent(repo)}` : '';

    try {
      const data = await requestReviewThreadApi<{ threads?: ReviewThread[] }>(
        `/api/panel/pr/review/threads?number=${prNumber}${repoParam}`,
      );
      const normalizedThreads = normalizeReviewThreads(Array.isArray(data.threads) ? data.threads : []);
      setReviewThreads(normalizedThreads);
      setReviewThreadsLoaded(true);
      return normalizedThreads;
    } catch (fetchError) {
      setReviewThreadsLoaded(true);
      setReviewThreadsError(fetchError instanceof Error ? fetchError.message : 'Failed to load review threads');
      throw fetchError;
    } finally {
      setReviewsLoading(false);
    }
  }, [prNumber, repo]);

  useEffect(() => {
    if (activeSection !== 'reviews' || reviewThreadsLoaded) return;
    let cancelled = false;
    void fetchReviewThreads().catch((fetchError) => {
      if (cancelled) return;
      setReviewThreadsError(fetchError instanceof Error ? fetchError.message : 'Failed to load review threads');
    });
    return () => { cancelled = true; };
  }, [activeSection, fetchReviewThreads, reviewThreadsLoaded]);

  /* ---------------------------------------------------------------- */
  /*  Thread interaction callbacks                                     */
  /* ---------------------------------------------------------------- */

  const toggleViewedThread = useCallback((threadId: string) => {
    setViewedThreadIds((current) => {
      if (current[threadId]) {
        const next = { ...current };
        delete next[threadId];
        return next;
      }
      return { ...current, [threadId]: true };
    });
  }, []);

  const toggleCollapsedThread = useCallback((threadId: string) => {
    setCollapsedThreadIds((current) => {
      if (current[threadId]) {
        const next = { ...current };
        delete next[threadId];
        return next;
      }
      return { ...current, [threadId]: true };
    });
  }, []);

  const submitThreadReply = useCallback(async (threadId: string) => {
    const thread = reviewThreads.find((candidate) => candidate.id === threadId);
    const draft = replyDrafts[threadId]?.trim() ?? '';

    if (!thread || !draft) return;

    const optimisticComment: ReviewThreadComment = {
      id: `optimistic-${threadId}-${Date.now()}`,
      databaseId: null,
      author: 'You',
      body: draft,
      createdAt: new Date().toISOString(),
      diffHunk: '',
      path: thread.path,
      line: thread.line,
      originalLine: thread.originalLine,
      url: '',
      isOptimistic: true,
    };
    const previousThread = thread;
    const optimisticThread = normalizeReviewThread({
      ...thread,
      latestCommentAt: optimisticComment.createdAt,
      comments: [...thread.comments, optimisticComment],
    });

    setThreadActionLoading((current) => ({ ...current, [threadId]: 'reply' }));
    setReviewThreads((current) => current.map((candidate) => candidate.id === threadId ? optimisticThread : candidate));
    setReplyDrafts((current) => ({ ...current, [threadId]: '' }));
    setViewedThreadIds((current) => ({ ...current, [threadId]: true }));
    setReviewThreadsError(null);

    try {
      const data = await requestReviewThreadApi<{ thread?: ReviewThread | null; threads?: ReviewThread[] }>(
        '/api/panel/pr/review/reply',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repo, number: prNumber, threadId, comment: draft }),
        },
      );
      const nextThreads = Array.isArray(data.threads)
        ? normalizeReviewThreads(data.threads)
        : null;
      if (nextThreads) {
        setReviewThreads(nextThreads);
      } else if (data.thread) {
        const normalizedThread = normalizeReviewThread(data.thread);
        setReviewThreads((current) => current.map((candidate) => candidate.id === threadId ? normalizedThread : candidate));
      }
      setActionResult({ type: 'success', message: 'Reply posted' });
    } catch (replyError) {
      setReviewThreads((current) => current.map((candidate) => candidate.id === threadId ? previousThread : candidate));
      setReplyDrafts((current) => ({ ...current, [threadId]: draft }));
      setActionResult({ type: 'error', message: replyError instanceof Error ? replyError.message : 'Failed to reply to review thread' });
    } finally {
      setThreadActionLoading((current) => {
        const next = { ...current };
        delete next[threadId];
        return next;
      });
    }
  }, [prNumber, replyDrafts, repo, reviewThreads]);

  const submitThreadResolve = useCallback(async (threadId: string, resolved: boolean) => {
    const thread = reviewThreads.find((candidate) => candidate.id === threadId);
    if (!thread) return;

    const previousThread = thread;
    const optimisticThread = normalizeReviewThread({
      ...thread,
      isResolved: resolved,
      status: resolved ? 'resolved' : (thread.isOutdated ? 'outdated' : 'active'),
    });

    setThreadActionLoading((current) => ({ ...current, [threadId]: resolved ? 'resolve' : 'unresolve' }));
    setReviewThreads((current) => current.map((candidate) => candidate.id === threadId ? optimisticThread : candidate));
    setViewedThreadIds((current) => ({ ...current, [threadId]: true }));
    setReviewThreadsError(null);

    try {
      const data = await requestReviewThreadApi<{ thread?: ReviewThread | null; threads?: ReviewThread[] }>(
        '/api/panel/pr/review/resolve',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repo, number: prNumber, threadId, resolved }),
        },
      );
      if (Array.isArray(data.threads)) {
        setReviewThreads(normalizeReviewThreads(data.threads));
      } else if (data.thread) {
        const normalizedThread = normalizeReviewThread(data.thread);
        setReviewThreads((current) => current.map((candidate) => candidate.id === threadId ? normalizedThread : candidate));
      }
      setActionResult({ type: 'success', message: resolved ? 'Thread resolved' : 'Thread reopened' });
    } catch (resolveError) {
      setReviewThreads((current) => current.map((candidate) => candidate.id === threadId ? previousThread : candidate));
      setActionResult({ type: 'error', message: resolveError instanceof Error ? resolveError.message : 'Failed to update thread state' });
    } finally {
      setThreadActionLoading((current) => {
        const next = { ...current };
        delete next[threadId];
        return next;
      });
    }
  }, [prNumber, repo, reviewThreads]);

  /* ---------------------------------------------------------------- */
  /*  Chat injection + comment helpers                                 */
  /* ---------------------------------------------------------------- */

  const injectPayload = useCallback((key: string, payload: AgentPanelChatInjectionPayload) => {
    if (!onInjectChatContext) return;
    onInjectChatContext(payload);
    setAddedContextKeys((current) => ({ ...current, [key]: true }));
  }, [onInjectChatContext]);

  const hideComment = useCallback((key: string) => {
    setHiddenCommentKeys((current) => ({ ...current, [key]: true }));
  }, []);

  const focusCommentComposer = useCallback(() => {
    setActiveSection('comments');
    requestAnimationFrame(() => {
      commentInputRef.current?.focus();
      commentInputRef.current?.select();
    });
  }, []);

  const openPullRequestOnGitHub = useCallback(() => {
    if (!repo) return;
    openExternalUrl(`https://github.com/${repo}/pull/${prNumber}`);
  }, [prNumber, repo]);

  const checkContextKey = useCallback((name?: string | null) => `check:${name ?? 'unknown'}`, []);

  const reload = useCallback(() => setReloadNonce((current) => current + 1), []);

  /* ---------------------------------------------------------------- */
  /*  Derived data                                                     */
  /* ---------------------------------------------------------------- */

  const currentChecks = pr?.statusCheckRollup ?? [];
  const currentAllComments = pr
    ? [
        ...pr.issueComments.map((comment) => ({ ...comment, kind: 'comment' as const })),
        ...pr.reviewComments.map((comment) => ({ ...comment, kind: 'review' as const })),
      ].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    : [];
  const currentVisibleComments = currentAllComments.filter((comment) => !hiddenCommentKeys[`${comment.kind}:${comment.id}`]);
  const currentVisibleReviewThreads = reviewThreads;
  const activeSectionItemCount = activeSection === 'files'
    ? (pr?.files?.length ?? 0)
    : activeSection === 'checks'
      ? currentChecks.length
      : activeSection === 'comments'
        ? currentVisibleComments.length
        : activeSection === 'reviews'
          ? currentVisibleReviewThreads.length
          : 0;

  /* ---------------------------------------------------------------- */
  /*  Active item index management                                     */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    setActiveItemIndex(0);
  }, [activeSection]);

  useEffect(() => {
    setActiveItemIndex((current) => Math.min(current, Math.max(0, activeSectionItemCount - 1)));
  }, [activeSectionItemCount]);

  useEffect(() => {
    if (activeSection === 'overview' || activeSectionItemCount === 0) return undefined;

    const frame = requestAnimationFrame(() => {
      const target = document.querySelector(
        `[data-pr-section="${activeSection}"][data-pr-index="${activeItemIndex}"]`,
      ) as HTMLElement | null;
      target?.scrollIntoView({ block: 'nearest' });
    });

    return () => cancelAnimationFrame(frame);
  }, [activeItemIndex, activeSection, activeSectionItemCount]);

  /* ---------------------------------------------------------------- */
  /*  Selected item action                                             */
  /* ---------------------------------------------------------------- */

  const runSelectedItemAction = useCallback(async () => {
    if (!pr) return;

    if (activeSection === 'files') {
      const selectedFile = pr.files?.[activeItemIndex];
      if (!selectedFile) return;
      await navigator.clipboard.writeText(selectedFile.path);
      setActionResult({ type: 'success', message: `Copied ${selectedFile.path}` });
      return;
    }

    if (activeSection === 'checks') {
      const selectedCheck = currentChecks[activeItemIndex];
      if (!selectedCheck) return;
      if (selectedCheck.detailsUrl) {
        openExternalUrl(selectedCheck.detailsUrl);
        return;
      }
      if (!onInjectChatContext) {
        setActionResult({ type: 'error', message: 'No quick action is available for this check here.' });
        return;
      }
      const checkName = selectedCheck.name || 'Unknown check';
      const injectionKey = checkContextKey(selectedCheck.name);
      if (addedContextKeys[injectionKey]) {
        setActionResult({ type: 'success', message: `${checkName} is already in chat.` });
        return;
      }
      injectPayload(
        injectionKey,
        formatCiCheckInjection({
          prNumber: pr.number,
          repo,
          name: checkName,
          status: selectedCheck.status,
          conclusion: selectedCheck.conclusion,
          detailsUrl: selectedCheck.detailsUrl,
          startedAt: selectedCheck.startedAt,
          completedAt: selectedCheck.completedAt,
        }),
      );
      setActionResult({ type: 'success', message: `Added ${checkName} to chat.` });
      return;
    }

    if (activeSection === 'comments') {
      const selectedComment = currentVisibleComments[activeItemIndex];
      if (!selectedComment) return;
      if (!onInjectChatContext) {
        setActionResult({ type: 'error', message: 'Chat injection is unavailable from this surface.' });
        return;
      }
      const commentKey = `${selectedComment.kind}:${selectedComment.id}`;
      if (addedContextKeys[commentKey]) {
        setActionResult({ type: 'success', message: 'That comment is already in chat.' });
        return;
      }
      injectPayload(
        commentKey,
        formatReviewCommentInjection({
          prNumber: pr.number,
          repo,
          author: selectedComment.user,
          body: selectedComment.body,
          createdAt: selectedComment.created_at,
          path: selectedComment.kind === 'review' ? (selectedComment as { path?: string }).path : undefined,
        }),
      );
      setActionResult({ type: 'success', message: `Added ${selectedComment.user}'s comment to chat.` });
      return;
    }

    if (activeSection === 'reviews') {
      const selectedReviewThread = currentVisibleReviewThreads[activeItemIndex];
      if (!selectedReviewThread) return;
      if (!onInjectChatContext) {
        setActionResult({ type: 'error', message: 'Chat injection is unavailable from this surface.' });
        return;
      }
      const reviewKey = `review-thread:${selectedReviewThread.id}`;
      if (addedContextKeys[reviewKey]) {
        setActionResult({ type: 'success', message: 'That review thread is already in chat.' });
        return;
      }
      injectPayload(
        reviewKey,
        formatReviewThreadInjection({
          prNumber: pr.number,
          repo,
          status: selectedReviewThread.status,
          path: selectedReviewThread.path,
          line: selectedReviewThread.line,
          comments: selectedReviewThread.comments.map((comment) => ({
            prNumber: pr.number,
            repo,
            author: comment.author,
            body: comment.body,
            createdAt: comment.createdAt,
            path: comment.path,
            line: comment.line,
          })),
        }),
      );
      setViewedThreadIds((current) => ({ ...current, [selectedReviewThread.id]: true }));
      setActionResult({ type: 'success', message: `Added ${selectedReviewThread.path} to chat.` });
    }
  }, [
    activeItemIndex,
    activeSection,
    addedContextKeys,
    currentChecks,
    currentVisibleComments,
    currentVisibleReviewThreads,
    checkContextKey,
    injectPayload,
    onInjectChatContext,
    pr,
    prNumber,
    repo,
  ]);

  /* ---------------------------------------------------------------- */
  /*  Keyboard handler                                                 */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    if (!pr) return undefined;

    const orderedSections: PRSection[] = ['overview', 'files', 'checks', 'comments', 'reviews'];
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTypingTarget = Boolean(
        target && (
          target.tagName === 'INPUT'
          || target.tagName === 'TEXTAREA'
          || target.isContentEditable
        ),
      );

      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && pr.state === 'OPEN' && commentText.trim()) {
        event.preventDefault();
        void submitAction('comment', commentText);
        return;
      }

      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }

      if (isTypingTarget) {
        if (event.key === 'Escape' && target === commentInputRef.current) {
          commentInputRef.current?.blur();
        }
        return;
      }

      if (/^[1-5]$/.test(event.key)) {
        const section = orderedSections[Number(event.key) - 1];
        if (section) {
          event.preventDefault();
          setActiveSection(section);
        }
        return;
      }

      if (event.key === '[' || event.key === ']') {
        event.preventDefault();
        const currentIndex = orderedSections.indexOf(activeSection);
        const delta = event.key === '[' ? -1 : 1;
        const nextIndex = Math.min(orderedSections.length - 1, Math.max(0, currentIndex + delta));
        setActiveSection(orderedSections[nextIndex]);
        return;
      }

      if (event.key.toLowerCase() === 'o' && repo) {
        event.preventDefault();
        openPullRequestOnGitHub();
        return;
      }

      if ((event.key.toLowerCase() === 'j' || event.key === 'ArrowDown') && activeSection !== 'overview' && activeSectionItemCount > 0) {
        event.preventDefault();
        setActiveItemIndex((current) => Math.min(activeSectionItemCount - 1, current + 1));
        return;
      }

      if ((event.key.toLowerCase() === 'k' || event.key === 'ArrowUp') && activeSection !== 'overview' && activeSectionItemCount > 0) {
        event.preventDefault();
        setActiveItemIndex((current) => Math.max(0, current - 1));
        return;
      }

      if (event.key === 'Enter' && activeSection !== 'overview' && activeSectionItemCount > 0) {
        event.preventDefault();
        void runSelectedItemAction();
        return;
      }

      if (pr.state !== 'OPEN') return;

      if (event.key.toLowerCase() === 'c') {
        event.preventDefault();
        focusCommentComposer();
        return;
      }

      if (actionLoading !== null) return;

      if (event.key.toLowerCase() === 'a') {
        event.preventDefault();
        void submitAction('approve', commentText || undefined);
        return;
      }

      if (event.key.toLowerCase() === 'r') {
        event.preventDefault();
        if (!commentText.trim()) {
          focusCommentComposer();
          return;
        }
        void submitAction('request-changes', commentText);
        return;
      }

      if (event.key.toLowerCase() === 'm') {
        event.preventDefault();
        void submitAction('merge');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    activeSection,
    activeSectionItemCount,
    actionLoading,
    commentText,
    focusCommentComposer,
    openPullRequestOnGitHub,
    pr,
    repo,
    runSelectedItemAction,
    submitAction,
  ]);

  return {
    pr,
    loading,
    error,
    activeSection,
    setActiveSection,
    activeItemIndex,
    reviewThreads,
    reviewsLoading,
    reviewThreadsError,
    replyDrafts,
    setReplyDrafts,
    threadActionLoading,
    viewedThreadIds,
    setViewedThreadIds,
    collapsedThreadIds,
    commentText,
    setCommentText,
    actionLoading,
    actionResult,
    addedContextKeys,
    hiddenCommentKeys,
    hoveredCommentKey,
    setHoveredCommentKey,
    commentInputRef,
    localRepo,
    currentChecks,
    currentAllComments,
    currentVisibleComments,
    currentVisibleReviewThreads,
    submitAction,
    fetchReviewThreads,
    toggleViewedThread,
    toggleCollapsedThread,
    submitThreadReply,
    submitThreadResolve,
    injectPayload,
    hideComment,
    focusCommentComposer,
    openPullRequestOnGitHub,
    checkContextKey,
    reload,
  };
}
