'use client';

import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore, type Dispatch, type SetStateAction } from 'react';
import type { ThoughtsAttachedImage } from './useThoughtsComposerAttachments';
import { MAX_COMPOSER_IMAGES } from '@/lib/hooks/use-file-drop';

interface ComposerDraft {
  input: string;
  images: ThoughtsAttachedImage[];
  files: string[];
  warning?: string;
}

const PREFIX = 'o8:composer-draft:v1:';
const LIMIT = 4_000_000;
const EMPTY: ComposerDraft = { input: '', images: [], files: [] };
const drafts = new Map<string, ComposerDraft>();
const listeners = new Set<() => void>();
const WARNING = 'Your latest draft changes could not be saved. Keep this window open to retain them.';

/** A workspace tab and its selected conversation own a draft independently of visibility. */
export function composerDraftKey(repoPath: string | null | undefined, tabId: string | undefined, threadId: string | null) {
  return tabId ? JSON.stringify([repoPath ?? null, threadId ? ['thread', threadId] : ['tab', tabId]]) : null;
}

function read(key: string): ComposerDraft {
  const cached = drafts.get(key);
  if (cached) return cached;
  let draft = EMPTY;
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    if (raw) {
      if (raw.length > LIMIT) throw new Error('Draft exceeds storage limit');
      const value: unknown = JSON.parse(raw);
      if (!validDraft(value)) throw new Error('Unreadable draft');
      draft = { input: value.input, images: value.images, files: value.files };
    }
  } catch { draft = { ...EMPTY, warning: WARNING }; }
  drafts.set(key, draft);
  return draft;
}

function validDraft(value: unknown): value is ComposerDraft {
  if (!value || typeof value !== 'object') return false;
  const draft = value as ComposerDraft;
  return typeof draft.input === 'string' && Array.isArray(draft.images) && draft.images.length <= MAX_COMPOSER_IMAGES
    && draft.images.every(image => image && typeof image.name === 'string' && typeof image.dataUri === 'string'
      && typeof image.mimeType === 'string' && image.mimeType.startsWith('image/')
      && image.dataUri.startsWith(`data:${image.mimeType};base64,`))
    && Array.isArray(draft.files) && draft.files.every(file => typeof file === 'string');
}

function write(key: string, draft: ComposerDraft) {
  const next: ComposerDraft = { ...draft, warning: undefined };
  try {
    if (!next.input && !next.images.length && !next.files.length) window.localStorage.removeItem(PREFIX + key);
    else {
      const raw = JSON.stringify({ input: next.input, images: next.images, files: next.files });
      if (raw.length > LIMIT) throw new Error('Draft exceeds storage limit');
      window.localStorage.setItem(PREFIX + key, raw);
    }
  } catch { next.warning = WARNING; }
  drafts.set(key, next);
  listeners.forEach(listener => listener());
  return !next.warning;
}

export function captureComposerDraft(key: string | null) {
  return key ? read(key) : EMPTY;
}

export function moveComposerDraft(from: string, to: string, draft: ComposerDraft) {
  if (!write(to, draft)) {
    drafts.set(from, { ...draft, warning: WARNING });
    listeners.forEach(listener => listener());
    return false;
  }
  if (from !== to) write(from, EMPTY);
  return true;
}

function storageChanged(event: StorageEvent) {
  if (event.storageArea !== window.localStorage || (event.key && !event.key.startsWith(PREFIX))) return;
  if (event.key) drafts.delete(event.key.slice(PREFIX.length)); else drafts.clear();
  listeners.forEach(listener => listener());
}
function subscribe(listener: () => void) {
  if (!listeners.size) window.addEventListener('storage', storageChanged);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) window.removeEventListener('storage', storageChanged);
  };
}

/** Write in the input/attachment action, without a debounce or a teardown-only save. */
export function useComposerDraftValue<K extends 'input' | 'images' | 'files'>(key: string | null, field: K, initial: ComposerDraft[K]) {
  const [transient, setTransient] = useState(initial);
  const owner = useRef<{ key: string | null; field: K } | null>(null);
  useLayoutEffect(() => {
    owner.current = { key, field };
    return () => { owner.current = null; };
  }, [key, field]);
  const snapshot = useCallback(() => key && typeof window !== 'undefined' ? read(key) : EMPTY, [key]);
  const draft = useSyncExternalStore(subscribe, snapshot, () => EMPTY);
  const setValue = useCallback<Dispatch<SetStateAction<ComposerDraft[K]>>>((update) => {
    if (!owner.current) return;
    const { key, field } = owner.current;
    if (!key) { setTransient(update); return; }
    const current = read(key);
    write(key, { ...current, [field]: typeof update === 'function' ? update(current[field]) : update });
  }, []);
  const captureOwner = useCallback(() => {
    const expected = owner.current;
    return () => expected !== null && owner.current === expected;
  }, []);
  return { value: key ? draft[field] : transient, setValue, captureOwner, warning: key ? draft.warning : undefined };
}

export function resetComposerDraftMemoryForTests() { drafts.clear(); }
