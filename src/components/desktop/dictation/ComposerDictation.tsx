'use client';

import { createContext, useContext, useEffect, useId, useRef, type RefObject } from 'react';
import { useDictationHostOptional } from './DictationHost';

export const ComposerDictationContext = createContext<string | null>(null);
export const useComposerDictationId = () => useContext(ComposerDictationContext);

/** Register each mounted draft, including unfocused worker panes. Focus selects only the keyboard target. */
export function useComposerDictation({
  nodeRef, onText, scopeKey, active, enabled = true,
}: {
  nodeRef: RefObject<HTMLTextAreaElement | null>;
  onText: (text: string) => void;
  scopeKey: string;
  active: boolean;
  enabled?: boolean;
}): string {
  const instance = useId();
  const id = `${instance}:${scopeKey}`;
  const host = useDictationHostOptional();
  const register = host?.registerComposer;
  const activate = host?.activateComposer;
  const delivery = useRef({ id, onText });
  useEffect(() => { delivery.current = { id, onText }; }, [id, onText]);
  useEffect(() => {
    const node = nodeRef.current;
    if (!enabled || !node || !register || !activate) return;
    const unregister = register({ id, node, fill: text => {
      if (delivery.current.id === id) delivery.current.onText(text);
    } });
    const claim = () => activate(id);
    node.addEventListener('focus', claim);
    return () => { node.removeEventListener('focus', claim); unregister(); };
  }, [activate, enabled, id, nodeRef, register]);
  useEffect(() => { if (enabled && active) activate?.(id); }, [activate, active, enabled, id]);
  return id;
}
