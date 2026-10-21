'use client';

import { useEffect, useState } from 'react';

const KEY = 'o8:openrouter-hidden-models';
const EVENT = 'o8:model-visibility-changed';
export const openRouterModelKey = (id: string) => id.replace(/^openrouter\//, '');

export function readHiddenModels(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === 'string' && id.length > 0).map(openRouterModelKey))].slice(0, 2000) : [];
  } catch { return []; }
}

/** Presentation preference only. Never changes a selected model or routing. */
export function useModelVisibility() {
  const [hidden, setHidden] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const sync = () => setHidden(readHiddenModels());
    sync();
    window.addEventListener('storage', sync);
    window.addEventListener(EVENT, sync);
    return () => { window.removeEventListener('storage', sync); window.removeEventListener(EVENT, sync); };
  }, []);
  const save = (next: string[]) => {
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
      setHidden(next); setError(null);
      window.dispatchEvent(new Event(EVENT));
    } catch { setError('Could not save model visibility on this device.'); }
  };
  return { hidden, error, restore: () => save([]), toggle: (id: string) => {
    const key = openRouterModelKey(id);
    const current = readHiddenModels();
    save(current.includes(key) ? current.filter(value => value !== key) : [...current, key]);
  } };
}
