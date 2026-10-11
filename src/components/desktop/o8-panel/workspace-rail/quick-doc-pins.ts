'use client';

import { useCallback, useEffect, useState } from 'react';

const CHANGE_EVENT = 'o8:quick-doc-pins-changed';
const EMPTY: string[] = [];
const storageKey = (repo: string) => `o8:quick-docs:pins:v1:${repo}`;

export function repoRelativeFile(repo: string | null | undefined, file: string | null) {
  if (!repo || !file) return null;
  const prefix = `${repo.replace(/\/$/, '')}/`;
  const relative = file.startsWith(prefix) ? file.slice(prefix.length) : file;
  return relative.startsWith('/') || /^[A-Za-z]:/.test(relative) || relative.split('/').some(part => !part || part === '.' || part === '..') ? null : relative;
}

function readPins(repo: string) {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(storageKey(repo)) ?? '[]');
    return Array.isArray(parsed) ? [...new Set(parsed.filter((value): value is string => typeof value === 'string' && repoRelativeFile(repo, value) === value))].slice(0, 50) : EMPTY;
  } catch { return EMPTY; }
}

/** Pins belong to this repo, and stay synchronized across its open panes. */
export function useQuickDocPins(repo: string | null | undefined) {
  const [snapshot, setSnapshot] = useState<{ repo: string | null; paths: string[] }>({ repo: null, paths: [] });
  const paths = snapshot.repo === (repo ?? null) ? snapshot.paths : EMPTY;
  useEffect(() => {
    let active = true;
    const refresh = () => { if (active) setSnapshot({ repo: repo ?? null, paths: repo ? readPins(repo) : [] }); };
    queueMicrotask(refresh);
    const storage = (event: StorageEvent) => { if (!event.key || repo && event.key === storageKey(repo)) refresh(); };
    window.addEventListener(CHANGE_EVENT, refresh);
    window.addEventListener('storage', storage);
    return () => { active = false; window.removeEventListener(CHANGE_EVENT, refresh); window.removeEventListener('storage', storage); };
  }, [repo]);
  const change = useCallback((file: string, pinned: boolean) => {
    const path = repoRelativeFile(repo, file);
    if (!repo || !path) return;
    const current = snapshot.repo === repo ? snapshot.paths : readPins(repo);
    const next = pinned ? [...new Set([...current, path])].slice(0, 50) : current.filter(value => value !== path);
    setSnapshot({ repo, paths: next });
    try { window.localStorage.setItem(storageKey(repo), JSON.stringify(next)); window.dispatchEvent(new Event(CHANGE_EVENT)); }
    catch { /* Pins remain usable in this pane when storage is unavailable. */ }
  }, [repo, snapshot]);
  return { paths, pin: (file: string) => change(file, true), unpin: (file: string) => change(file, false) };
}
