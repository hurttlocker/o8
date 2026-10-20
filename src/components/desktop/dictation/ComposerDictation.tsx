'use client';

import { createContext, useCallback, useContext, useEffect, useId, useRef, type ForwardedRef, type RefObject } from 'react';
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
  const deactivate = host?.deactivateComposer;
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
  useEffect(() => {
    if (!enabled || !active) return;
    activate?.(id);
    // A hidden tab remains mounted. Revoke only its next keyboard/system-fill
    // destination; an existing recording retains its original composer owner.
    return () => deactivate?.(id);
  }, [activate, active, deactivate, enabled, id]);
  return id;
}

/** Share the mounted textarea with dictation and the parent's existing ref. */
export function useComposerTextareaRef(inputRef: ForwardedRef<HTMLTextAreaElement>) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const setTextareaRef = useCallback((node: HTMLTextAreaElement | null) => {
    textareaRef.current = node;
    if (typeof inputRef === 'function') inputRef(node);
    // eslint-disable-next-line react-hooks/immutability -- React assigns forwarded refs in this ref callback, outside render.
    else if (inputRef) inputRef.current = node;
  }, [inputRef]);
  return [textareaRef, setTextareaRef] as const;
}
