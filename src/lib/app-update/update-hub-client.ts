'use client';

import { useSyncExternalStore } from 'react';
import type { CliUpdateRecord } from '@/lib/setup/cli-updates';
import type { ReleaseNotes } from './release-notes';

export interface AppUpdateView {
  version: string | null;
  outcome: 'never' | 'available' | 'current' | 'failed';
  installing: boolean;
  message: string | null;
  error: string | null;
  downloadOnly: boolean;
}
interface UpdateHub {
  app: AppUpdateView;
  tools: CliUpdateRecord[];
  checking: boolean;
  checkingAll: boolean;
  cliBusy: string | null;
  syncing: boolean;
  cliError: string | null;
  checkedAt: number;
}
const initial: UpdateHub = { app: { version: null, outcome: 'never', installing: false, message: null, error: null, downloadOnly: false },
  tools: [], checking: false, checkingAll: false, cliBusy: null, syncing: false, cliError: null, checkedAt: 0 };
type AppCheckResult = { version: string | null; error?: string };
export type UpdateCheckResult = { hasUpdates: boolean; incomplete: boolean };
const global = globalThis as typeof globalThis & { __o8UpdateHub?: { snapshot: UpdateHub; listeners: Set<() => void>;
  check?: Promise<void>; sync?: Promise<void>; allCheck?: Promise<UpdateCheckResult>; appCheck?: () => Promise<AppCheckResult> } };
const hub = global.__o8UpdateHub ??= { snapshot: initial, listeners: new Set() };
function patch(value: Partial<UpdateHub>) { hub.snapshot = { ...hub.snapshot, ...value }; for (const listener of hub.listeners) listener(); }
export function publishAppUpdateView(app: AppUpdateView) {
  if (JSON.stringify(hub.snapshot.app) !== JSON.stringify(app)) patch({ app });
}
export function useUpdateHub() {
  return useSyncExternalStore(listener => { hub.listeners.add(listener); return () => hub.listeners.delete(listener); }, () => hub.snapshot, () => initial);
}

export function registerAppUpdateCheck(check: () => Promise<AppCheckResult>) {
  hub.appCheck = check;
  return () => { if (hub.appCheck === check) hub.appCheck = undefined; };
}

/** An explicit check combines app and installed CLI results without installing. */
export function checkAllUpdates(): Promise<UpdateCheckResult> {
  if (hub.allCheck) return hub.allCheck;
  patch({ checkingAll: true });
  hub.allCheck = (async () => {
    const [app] = await Promise.all([
      hub.appCheck ? hub.appCheck().catch(() => ({ version: null, error: 'o8 update check failed.' }))
        : Promise.resolve({ version: null, error: 'o8 update checking is unavailable.' }),
      refreshCliUpdateView(true),
    ]);
    const installed = hub.snapshot.tools.filter(tool => tool.runtimeId !== 'gemini' && tool.status !== 'not-installed');
    const incompleteReport = ['codex', 'claude-code', 'grok'].some(runtime => hub.snapshot.tools.filter(tool => tool.runtimeId === runtime).length !== 1);
    return { hasUpdates: Boolean(app.version) || installed.some(tool => tool.status === 'update-available'),
      incomplete: incompleteReport || Boolean(app.error || hub.snapshot.cliError) || installed.some(tool => tool.status === 'unknown') };
  })().finally(() => { patch({ checkingAll: false }); hub.allCheck = undefined; });
  return hub.allCheck;
}

/** One shared check; opening a hover never installs or starts a model turn. */
export async function refreshCliUpdateView(fresh = false): Promise<void> {
  if (hub.check) return hub.check;
  const ttl = hub.snapshot.tools.some(tool => tool.status === 'unknown') ? 60_000 : 30 * 60_000;
  if (!fresh && Date.now() - hub.snapshot.checkedAt < ttl) return;
  hub.check = (async () => {
    patch({ checking: true, cliError: null });
    try {
      const response = await fetch(`/api/setup/cli-updates${fresh ? '?refresh=1' : ''}`, { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error('CLI update checks are unavailable.');
      const payload = await response.json() as { tools: CliUpdateRecord[] };
      if (!Array.isArray(payload.tools)) throw new Error('CLI update checks are unavailable.');
      patch({ tools: payload.tools, checkedAt: Date.now() });
    } catch { patch({ cliError: 'CLI checks couldn’t finish. Try again.' }); }
    finally { patch({ checking: false }); }
  })().finally(() => { hub.check = undefined; });
  return hub.check;
}

/** Run from the explicit install path while the old server is still available. */
export async function synchronizeConnectedClis(): Promise<void> {
  if (hub.sync) return hub.sync;
  hub.sync = (async () => {
    patch({ syncing: true });
    await refreshCliUpdateView(true);
    if (hub.snapshot.cliError) throw new Error(hub.snapshot.cliError);
    const connected = ['codex', 'claude-code', 'grok'].map(runtime => {
      const matches = hub.snapshot.tools.filter(item => item.runtimeId === runtime);
      if (matches.length !== 1) throw new Error('The connected CLI report is incomplete. Check again before updating.');
      return matches[0]!;
    });
    for (const tool of connected) {
      if (tool.status === 'not-installed' || tool.status === 'current') continue;
      if (tool.status === 'unknown') throw new Error(`${tool.label}: the release could not be verified. Check again before updating.`);
      patch({ cliBusy: tool.runtimeId, cliError: null });
      try {
        const response = await fetch('/api/setup/cli-updates', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ runtime: tool.runtimeId }), signal: AbortSignal.timeout(200_000) });
        const result = await response.json() as { status?: string; error?: string };
        if (!response.ok || result.status !== 'succeeded') throw new Error(`${tool.label}: ${result.error ?? 'The update could not be verified.'}`);
      } finally { patch({ cliBusy: null }); }
    }
    await refreshCliUpdateView(true);
    if (hub.snapshot.cliError) throw new Error(hub.snapshot.cliError);
    for (const tool of connected.filter(item => item.status !== 'not-installed')) {
      const matches = hub.snapshot.tools.filter(item => item.runtimeId === tool.runtimeId);
      if (matches.length !== 1 || matches[0]?.status !== 'current') {
        throw new Error(`${tool.label}: the final version check did not confirm this CLI is current. Check again before updating o8.`);
      }
    }
  })().catch(error => { patch({ cliBusy: null, cliError: error instanceof Error ? error.message : 'CLI updates could not finish.' }); throw error; })
    .finally(() => { patch({ syncing: false }); hub.sync = undefined; });
  return hub.sync;
}

const notesTasks = new Map<string, { at: number; task: Promise<ReleaseNotes> }>();
export function loadCachedReleaseNotes(version = 'latest'): Promise<ReleaseNotes> {
  const key = `o8:release-notes:v1:${version}`;
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? 'null') as { at: number; notes: ReleaseNotes } | null;
    if (saved?.notes.entries && Date.now() - saved.at < 6 * 60 * 60_000) return Promise.resolve(saved.notes);
  } catch { /* Local storage is optional. */ }
  const pending = notesTasks.get(version);
  if (pending && Date.now() - pending.at < 6 * 60 * 60_000) return pending.task;
  const task = (async () => {
    const response = await fetch(`/api/panel/o8-update-summary?version=${encodeURIComponent(version)}`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error('Release notes are unavailable.');
    const notes = await response.json() as ReleaseNotes;
    try { localStorage.setItem(key, JSON.stringify({ at: Date.now(), notes })); } catch { /* Shared memory still caches the published result. */ }
    return notes;
  })().catch(error => { notesTasks.delete(version); throw error; });
  notesTasks.set(version, { at: Date.now(), task });
  return task;
}
