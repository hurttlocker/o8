'use client';

import {
  parseRippleResolutionResult,
  parseRippleConfirmedEpisode,
  type RippleAodlPatch,
  type RippleChoice,
  type RippleChoiceResolution,
  type RippleEpisode,
  type RippleDraftScope,
  type RippleResolutionResult,
} from './ripple-contract';

const EPISODE_STORAGE_KEY = 'o8.ripple.episodes.v1';
const MAX_EPISODES = 100;
const PATCH_TTL_MS = 10 * 60 * 1000;

type PendingPatch = {
  episode: RippleEpisode & { scope: RippleDraftScope };
  expiresAt: number;
};

const pendingByDraft = new Map<string, PendingPatch>();

export async function requestRippleResolution({
  utterance,
  repoName,
}: {
  utterance: string;
  repoName?: string;
}): Promise<RippleResolutionResult> {
  try {
    const response = await fetch('/api/mobile/ripple/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        utterance,
        ...(repoName ? { repoName } : {}),
      }),
    });
    if (!response.ok) return { kind: 'none' };
    const parsed = parseRippleResolutionResult(await response.json().catch(() => null));
    return parsed ?? { kind: 'none' };
  } catch {
    return { kind: 'none' };
  }
}

function persistEpisode(episode: RippleEpisode): void {
  if (typeof window === 'undefined') return;
  try {
    const current = JSON.parse(window.localStorage.getItem(EPISODE_STORAGE_KEY) ?? '[]') as unknown;
    const episodes = Array.isArray(current) ? current.filter((entry) => entry && typeof entry === 'object') : [];
    const previous = episodes.findIndex((entry) => entry.scope?.draftId === episode.scope?.draftId);
    if (previous >= 0) episodes[previous] = episode;
    else episodes.push(episode);
    window.localStorage.setItem(EPISODE_STORAGE_KEY, JSON.stringify(episodes.slice(-MAX_EPISODES)));
  } catch {
    // Learning receipts are best-effort and must never block the interaction.
  }
}

export function rememberRippleResolution({
  utterance,
  resolution,
  choice,
  resolutionMs,
  scope,
}: {
  utterance: string;
  resolution: RippleChoiceResolution;
  choice: RippleChoice;
  resolutionMs: number;
  scope: RippleDraftScope;
}): RippleAodlPatch {
  const patch: RippleAodlPatch = {
    path: resolution.aodlPath,
    value: choice.value,
    source: 'ripple',
    resolutionId: resolution.id,
  };
  const episode = {
    version: 1 as const,
    utterance,
    resolution,
    selectedValue: choice.value,
    patch,
    resolutionMs,
    resolvedAt: new Date().toISOString(),
    scope: { ...scope },
  };
  for (const [id, pending] of pendingByDraft) {
    if (pending.expiresAt <= Date.now()) pendingByDraft.delete(id);
  }
  pendingByDraft.set(scope.draftId, { episode, expiresAt: Date.now() + PATCH_TTL_MS });
  persistEpisode(episode);

  return patch;
}

export function discardRippleDraft(draftId: string): void {
  pendingByDraft.delete(draftId);
}

export function rippleDraftForQueue(draftId: unknown, threadId: string, repoPath: string | null, utterance: string): RippleEpisode | null {
  if (typeof draftId !== 'string') return null;
  const pending = pendingByDraft.get(draftId);
  if (!pending || pending.expiresAt <= Date.now()) return null;
  const { episode } = pending;
  return episode.scope.threadId === threadId && episode.scope.repoPath === repoPath && episode.utterance === utterance ? episode : null;
}

export function restoreQueuedRippleDraft(value: unknown, threadId: string, repoPath: string | null, text: string): { draftId: string; utterance: string } | null {
  const episode = parseRippleConfirmedEpisode(value);
  if (!episode || episode.scope.threadId !== threadId || episode.scope.repoPath !== repoPath || episode.utterance.trim() !== text) return null;
  pendingByDraft.set(episode.scope.draftId, { episode, expiresAt: Date.now() + PATCH_TTL_MS });
  return { draftId: episode.scope.draftId, utterance: episode.utterance };
}

export function consumeRippleContextForMessage({ draftId, threadId, repoPath, utterance, messageId }: {
  draftId: unknown;
  threadId?: string;
  repoPath: string | null;
  utterance: string;
  messageId: string;
}): RippleAodlPatch[] {
  if (typeof draftId !== 'string' || !messageId || !threadId) return [];
  const pending = pendingByDraft.get(draftId);
  if (!pending) return [];
  if (pending.expiresAt <= Date.now()) {
    pendingByDraft.delete(draftId);
    return [];
  }
  const { episode } = pending;
  if (episode.scope.threadId !== threadId || episode.scope.repoPath !== repoPath || episode.utterance !== utterance) return [];
  pendingByDraft.delete(draftId);
  persistEpisode({ ...episode, messageId });
  return [episode.patch];
}
