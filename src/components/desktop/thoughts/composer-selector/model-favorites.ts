'use client';

import { useEffect, useState } from 'react';

export interface ModelFavorite {
  house: string;
  id: string;
  label: string;
}

export function modelFavoriteKey(model: Pick<ModelFavorite, 'house' | 'id'>): string {
  return `${model.house}:${model.id}`;
}

export function readModelFavorites(scope: string): ModelFavorite[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(`o8:model-favorites:${scope}`) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    return parsed.filter((item): item is ModelFavorite => {
      if (!item || typeof item !== 'object') return false;
      const value = item as Partial<ModelFavorite>;
      if (typeof value.house !== 'string' || !value.house || typeof value.id !== 'string' || !value.id || typeof value.label !== 'string') return false;
      const key = modelFavoriteKey(value as ModelFavorite);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 64);
  } catch {
    return [];
  }
}

/** Favorites describe a preference; the live catalogue still authorizes selection. */
export function useModelFavorites(scope: string) {
  const [favorites, setFavorites] = useState<ModelFavorite[]>([]);
  useEffect(() => {
    const read = () => setFavorites(readModelFavorites(scope));
    read();
    window.addEventListener('storage', read);
    window.addEventListener('o8:model-favorites-changed', read);
    return () => {
      window.removeEventListener('storage', read);
      window.removeEventListener('o8:model-favorites-changed', read);
    };
  }, [scope]);
  const toggleFavorite = (model: ModelFavorite) => {
    const current = readModelFavorites(scope);
    const key = modelFavoriteKey(model);
    const next = current.some((item) => modelFavoriteKey(item) === key)
      ? current.filter((item) => modelFavoriteKey(item) !== key)
      : [...current, model].slice(-64);
    setFavorites(next);
    try {
      window.localStorage.setItem(`o8:model-favorites:${scope}`, JSON.stringify(next));
      window.dispatchEvent(new Event('o8:model-favorites-changed'));
    } catch {
      // Storage restrictions must not prevent a model choice.
    }
  };
  return { favorites, toggleFavorite };
}
