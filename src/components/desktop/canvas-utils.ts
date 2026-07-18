/**
 * Shared utilities and types used across Canvas viewer components.
 */

import React from 'react';
import type { RepoReadiness } from '@/lib/repos/types';

/** CSS var overrides to force light-mode text on white canvas backgrounds. */
export const LIGHT_CANVAS_VARS = {
  '--t-text': '#111827',
  '--t-text-strong': '#0f172a',
  '--t-text-secondary': '#4b5563',
  '--t-text-muted': '#6b7280',
  '--t-text-faint': '#9ca3af',
  '--t-divider': '#e5e7eb',
  '--t-divider-subtle': '#f3f4f6',
  '--t-panel': '#ffffff',
  '--t-panel-translucent': 'rgba(249,250,251,0.9)',
  '--t-panel-shadow': '0 1px 3px rgba(0,0,0,0.08)',
  '--t-code-bg': '#f3f4f6',
} as React.CSSProperties;

export type CanvasRepoTaskLaunchRequest =
  | { kind: 'issue'; repo: string; number: number; title: string; body?: string }
  | { kind: 'pr'; repo: string; number: number; title: string; branch?: string };

export function repoSlugFromRemote(remoteUrl: string | null | undefined) {
  if (!remoteUrl) return null;
  const match = remoteUrl.match(/github\.com[/:]([^/]+\/[^/.]+)(?:\.git)?$/i);
  return match?.[1] ?? null;
}

export function readinessTone(readiness?: RepoReadiness | null) {
  switch (readiness?.state) {
    case 'ready':
      return { background: 'rgba(34,197,94,0.08)', border: 'rgba(34,197,94,0.16)', color: '#15803d' };
    case 'needs_setup':
      return { background: 'rgba(245,158,11,0.10)', border: 'rgba(245,158,11,0.18)', color: '#b45309' };
    case 'missing':
    case 'blocked':
      return { background: 'rgba(239,68,68,0.10)', border: 'rgba(239,68,68,0.18)', color: '#b91c1c' };
    default:
      return { background: 'rgba(148,163,184,0.12)', border: 'rgba(148,163,184,0.2)', color: '#475569' };
  }
}

export function formatAge(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  // Same NaN guard as relativeAge — bad dates must not render "NaNmo ago".
  if (!Number.isFinite(then)) return '';
  const diffMs = now - then;
  const hours = Math.floor(diffMs / 3_600_000);
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}
