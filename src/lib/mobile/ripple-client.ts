'use client';

import {
  parseRippleResolutionResult,
  type RippleAodlPatch,
  type RippleChoice,
  type RippleChoiceResolution,
  type RippleEpisode,
  type RippleResolutionResult,
} from './ripple-contract';

const EPISODE_STORAGE_KEY = 'o8.ripple.episodes.v1';
const MAX_EPISODES = 100;
const PATCH_TTL_MS = 10 * 60 * 1000;

type PendingPatch = {
  patch: RippleAodlPatch;
  expiresAt: number;
};

const pendingByMessage = new Map<string, PendingPatch[]>();

function messageKey(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

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
    episodes.push(episode);
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
}: {
  utterance: string;
  resolution: RippleChoiceResolution;
  choice: RippleChoice;
  resolutionMs: number;
}): RippleAodlPatch {
  const patch: RippleAodlPatch = {
    path: resolution.aodlPath,
    value: choice.value,
    source: 'ripple',
    resolutionId: resolution.id,
  };
  const key = messageKey(utterance);
  const current = pendingByMessage.get(key) ?? [];
  pendingByMessage.set(key, [
    ...current.filter((entry) => entry.expiresAt > Date.now()),
    { patch, expiresAt: Date.now() + PATCH_TTL_MS },
  ]);

  persistEpisode({
    version: 1,
    utterance,
    resolution,
    selectedValue: choice.value,
    patch,
    resolutionMs,
    resolvedAt: new Date().toISOString(),
  });

  return patch;
}

export function getRippleContextForMessage(message: string): RippleAodlPatch[] {
  const key = messageKey(message);
  const current = pendingByMessage.get(key) ?? [];
  const active = current.filter((entry) => entry.expiresAt > Date.now());
  if (active.length !== current.length) {
    if (active.length > 0) pendingByMessage.set(key, active);
    else pendingByMessage.delete(key);
  }
  return active.map((entry) => entry.patch);
}
