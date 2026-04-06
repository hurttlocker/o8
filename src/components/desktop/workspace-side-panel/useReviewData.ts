'use client';

import { useEffect, useMemo, useState } from 'react';
import type { WorkflowReviewSnapshot } from '@/lib/fleet/types';
import type {
  WorkspaceSidePanelRepo,
  WorkspaceReviewCheckRun,
  WorkspaceReviewCheckRunDetail,
  WorkspaceDeploymentItem,
  WorkspacePullRequestDetail,
} from './types';
import {
  repoSlugFromRemote,
  fetchJsonWithTimeout,
  shortSha,
} from './shared';

function wsListen(events: string[], handler: () => void, fallbackMs: number) {
  for (const e of events) window.addEventListener(e, handler);
  const fallbackId = window.setInterval(handler, fallbackMs);
  return () => {
    for (const e of events) window.removeEventListener(e, handler);
    window.clearInterval(fallbackId);
  };
}

/** Encapsulates the four fetch effects used by ReviewTab. */
export function useReviewData(repo: WorkspaceSidePanelRepo | null, reloadNonce = 0) {
  const [snapshot, setSnapshot] = useState<WorkflowReviewSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [checks, setChecks] = useState<WorkspaceReviewCheckRun[]>([]);
  const [checksLoading, setChecksLoading] = useState(false);
  const [deployments, setDeployments] = useState<WorkspaceDeploymentItem[]>([]);
  const [deployLoading, setDeployLoading] = useState(false);

  const workspaceQuery = useMemo(() => (
    repo?.localPath ? `workspace=${encodeURIComponent(repo.localPath)}` : ''
  ), [repo?.localPath]);
  const repoSlug = useMemo(() => repoSlugFromRemote(repo?.remoteUrl), [repo?.remoteUrl]);
  const reviewQuery = useMemo(() => {
    const parts = [workspaceQuery, 'strictBranch=1'];
    if (repoSlug) parts.push(`repo=${encodeURIComponent(repoSlug)}`);
    return parts.filter(Boolean).length ? `?${parts.filter(Boolean).join('&')}` : '';
  }, [repoSlug, workspaceQuery]);

  // ── Fetch review snapshot ──────────────────────────────────────────
  useEffect(() => {
    let active = true;
    async function fetchReview() {
      setLoading(true);
      try {
        const data = await fetchJsonWithTimeout<WorkflowReviewSnapshot>(`/api/review/workspace${reviewQuery}`, 12000);
        if (!active) return;
        setSnapshot(data);
      } catch {
        if (!active) return;
        setSnapshot(null);
      } finally {
        if (active) setLoading(false);
      }
    }
    void fetchReview();
    const handler = () => { void fetchReview(); };
    const cleanup = wsListen(['o8:lane-lifecycle', 'o8:review'], handler, 300_000);
    return () => { active = false; cleanup(); };
  }, [reviewQuery, reloadNonce]);

  // ── Fetch CI checks ────────────────────────────────────────────────
  useEffect(() => {
    const slug = repoSlug;
    if (!slug) { setChecks([]); return; }
    const repoParam = encodeURIComponent(slug);
    let active = true;
    async function fetchChecks() {
      setChecksLoading(true);
      try {
        const res = await fetch(`/api/panel/ci?repo=${repoParam}`);
        const data = await res.json() as { runs?: WorkspaceReviewCheckRun[] };
        if (!active) return;
        const nextRuns = Array.isArray(data.runs) ? data.runs : [];
        nextRuns.sort((left, right) => {
          const leftFailed = Boolean(left.conclusion) && left.conclusion.toLowerCase() !== 'success';
          const rightFailed = Boolean(right.conclusion) && right.conclusion.toLowerCase() !== 'success';
          const leftPending = !left.conclusion || left.status?.toLowerCase() !== 'completed';
          const rightPending = !right.conclusion || right.status?.toLowerCase() !== 'completed';
          const leftRank = leftFailed ? 0 : leftPending ? 1 : 2;
          const rightRank = rightFailed ? 0 : rightPending ? 1 : 2;
          if (leftRank !== rightRank) return leftRank - rightRank;
          return new Date(right.updatedAt || right.createdAt).getTime() - new Date(left.updatedAt || left.createdAt).getTime();
        });
        setChecks(nextRuns);
      } catch {
        if (!active) return;
        setChecks([]);
      } finally {
        if (active) setChecksLoading(false);
      }
    }
    void fetchChecks();
    const handler = () => { void fetchChecks(); };
    const cleanup = wsListen(['o8:lane-lifecycle', 'o8:review'], handler, 300_000);
    return () => { active = false; cleanup(); };
  }, [repoSlug]);

  // ── Fetch deployments ──────────────────────────────────────────────
  useEffect(() => {
    let active = true;
    async function fetchDeploys() {
      setDeployLoading(true);
      try {
        const primary = await fetch(`/api/panel/deployments?project=${encodeURIComponent(repo?.name ?? '')}&limit=6`);
        const primaryData = await primary.json() as { deployments?: Array<{
          uid: string; name: string; url: string; state: string; created: number;
          ready?: number; target?: string;
          meta?: { githubCommitSha?: string; githubCommitMessage?: string };
        }> };
        let nextDeploys: WorkspaceDeploymentItem[] = Array.isArray(primaryData.deployments)
          ? primaryData.deployments.map((d) => ({
              id: d.uid, label: d.name || repo?.name || 'Deploy',
              environment: d.target ?? undefined, state: d.state,
              url: d.url ? `https://${d.url}` : undefined,
              sha: shortSha(d.meta?.githubCommitSha) ?? undefined,
              createdAt: d.ready ? new Date(d.ready).toISOString() : new Date(d.created).toISOString(),
              target: d.target ?? undefined,
              commitMessage: d.meta?.githubCommitMessage, source: 'vercel' as const,
            }))
          : [];
        if (!nextDeploys.length && repoSlug) {
          const fallback = await fetch(`/api/panel/deploys?repo=${encodeURIComponent(repoSlug)}`);
          const fallbackData = await fallback.json() as { deployments?: Array<{
            name?: string; environment?: string; sha?: string; createdAt?: string; state?: string;
          }> };
          nextDeploys = Array.isArray(fallbackData.deployments)
            ? fallbackData.deployments.map((d, i) => ({
                id: `${d.environment ?? 'deploy'}:${d.sha ?? i}`,
                label: d.name || repo?.name || 'Deploy', environment: d.environment,
                state: d.state ?? 'unknown', sha: shortSha(d.sha) ?? undefined,
                createdAt: d.createdAt, source: 'github' as const,
              }))
            : [];
        }
        if (!active) return;
        nextDeploys.sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime());
        setDeployments(nextDeploys);
      } catch {
        if (!active) return;
        setDeployments([]);
      } finally {
        if (active) setDeployLoading(false);
      }
    }
    void fetchDeploys();
    const handler = () => { void fetchDeploys(); };
    const cleanup = wsListen(['o8:lane-lifecycle', 'o8:review'], handler, 300_000);
    return () => { active = false; cleanup(); };
  }, [repo?.name, repoSlug]);

  return {
    snapshot, loading, checks, checksLoading,
    deployments, deployLoading, repoSlug,
  };
}

/** Fetches PR detail when an active PR is known. */
export function usePrDetail(
  activePrNumber: number | null,
  repoSlug: string | null,
  reviewReloadNonce: number,
) {
  const [prDetail, setPrDetail] = useState<WorkspacePullRequestDetail | null>(null);
  const [commentsLoading, setCommentsLoading] = useState(false);

  useEffect(() => {
    if (!activePrNumber || !repoSlug) { setPrDetail(null); return; }
    const repoParam = encodeURIComponent(repoSlug);
    let active = true;
    async function fetchPullRequestDetail() {
      setCommentsLoading(true);
      try {
        const data = await fetchJsonWithTimeout<WorkspacePullRequestDetail>(`/api/panel/prs/${activePrNumber}?repo=${repoParam}`, 12000);
        if (!active) return;
        setPrDetail(data);
      } catch {
        if (!active) return;
        setPrDetail(null);
      } finally {
        if (active) setCommentsLoading(false);
      }
    }
    void fetchPullRequestDetail();
    const handler = () => { void fetchPullRequestDetail(); };
    const cleanup = wsListen(['o8:lane-lifecycle', 'o8:review'], handler, 300_000);
    return () => { active = false; cleanup(); };
  }, [activePrNumber, repoSlug, reviewReloadNonce]);

  return { prDetail, commentsLoading };
}

/** Fetches run detail on hover. */
export function useRunDetail(hoveredRunId: number | null, repoSlug: string | null) {
  const [runDetail, setRunDetail] = useState<WorkspaceReviewCheckRunDetail['run'] | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    if (!repoSlug || !hoveredRunId) { setRunDetail(null); return; }
    const repoParam = encodeURIComponent(repoSlug);
    let active = true;
    async function fetchRunDetail() {
      setDetailLoading(true);
      try {
        const res = await fetch(`/api/panel/ci/${hoveredRunId}?repo=${repoParam}`);
        const data = await res.json() as WorkspaceReviewCheckRunDetail;
        if (!active) return;
        setRunDetail(data.run ?? null);
      } catch {
        if (!active) return;
        setRunDetail(null);
      } finally {
        if (active) setDetailLoading(false);
      }
    }
    void fetchRunDetail();
    return () => { active = false; };
  }, [hoveredRunId, repoSlug]);

  return { runDetail, detailLoading };
}
