import { useEffect, useRef, useState } from 'react';
import { EMPTY_DATA, fetchRepoActivity, REMOTE_ACTIVITY_DELAYED, type RepoActivityData } from './o8-activity-helpers';

type ActivityTarget = { repo: string | null; path: string | null };
const targetKey = (target: ActivityTarget) => JSON.stringify([target.repo?.toLowerCase() ?? null, target.path]);

// Transcript delivery cannot change the remote repository activity lists.
// Keep unknown or mixed batches conservative so review and attention updates
// still refresh immediately through the existing single-flight scheduler.
function isTranscriptOnlyBatch(event: Event): boolean {
  const detail = (event as CustomEvent<{ data?: { events?: unknown } }>).detail;
  const events = detail?.data?.events;
  return Array.isArray(events) && events.length > 0 && events.every((entry: unknown) => {
    if (!entry || typeof entry !== 'object') return false;
    const envelope = entry as { channel?: unknown; event?: unknown };
    return envelope.channel === 'history' && envelope.event === 'history.snapshot';
  });
}

/** Retain remote streams per repository and checkout, while always revalidating local history. */
export function useO8ActivityData(targets: ActivityTarget[], active: boolean, allRepos: boolean, retryNonce: number) {
  const scope = JSON.stringify([allRepos, targets.map(targetKey)]);
  const cache = useRef(new Map<string, RepoActivityData>());
  const [snapshot, setSnapshot] = useState({ scope, data: EMPTY_DATA, loading: true });

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const controller = new AbortController();
    let inFlight: Promise<void> | null = null;
    let trailingRefresh = false;

    async function load(showSpinner: boolean) {
      if (showSpinner) setSnapshot(previous => ({ scope, data: previous.scope === scope ? previous.data : EMPTY_DATA, loading: true }));
      const results = await Promise.all(targets.map(async target => {
        const key = targetKey(target);
        const result = await fetchRepoActivity(target.repo, target.path, { previous: cache.current.get(key), signal: controller.signal });
        return { key, result };
      }));
      // Some transports may ignore abort. Neither publish nor seed a retained snapshot from an obsolete read.
      if (cancelled) return;
      for (const { key, result } of results) cache.current.set(key, result);
      let data = results[0]?.result ?? EMPTY_DATA;
      if (allRepos) {
        data = { commits: [], prs: [], issues: [], ciRuns: [] };
        for (const { result } of results) {
          data.commits.push(...result.commits);
          data.prs.push(...result.prs);
          data.issues.push(...result.issues);
          data.ciRuns.push(...result.ciRuns);
        }
        if (results.some(({ result }) => result.workspaceError)) data.workspaceError = 'Some folders could not be read. Select a folder to inspect its activity and recovery options.';
        if (results.some(({ result }) => result.remoteError)) data.remoteError = REMOTE_ACTIVITY_DELAYED;
      }
      setSnapshot({ scope, data, loading: false });
    }

    function scheduleLoad(showSpinner = false) {
      if (inFlight) {
        trailingRefresh = true;
        return;
      }
      inFlight = load(showSpinner).finally(() => {
        inFlight = null;
        if (trailingRefresh && !cancelled) {
          trailingRefresh = false;
          scheduleLoad();
        }
      });
    }

    scheduleLoad(true);
    const handler = () => { scheduleLoad(); };
    const handleRealtime = (event: Event) => {
      if (!isTranscriptOnlyBatch(event)) scheduleLoad();
    };
    window.addEventListener('o8:realtime', handleRealtime);
    window.addEventListener('o8:lifecycle-reconcile', handler);
    const fallbackId = setInterval(handler, 300_000);
    return () => {
      cancelled = true;
      controller.abort();
      window.removeEventListener('o8:realtime', handleRealtime);
      window.removeEventListener('o8:lifecycle-reconcile', handler);
      clearInterval(fallbackId);
    };
  }, [active, scope, targets, allRepos, retryNonce]);

  return snapshot.scope === scope ? snapshot : { scope, data: EMPTY_DATA, loading: true };
}
