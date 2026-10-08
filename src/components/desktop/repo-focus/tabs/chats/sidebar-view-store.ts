'use client';

import { useEffect, useId, useSyncExternalStore } from 'react';
import { CHAT_GROUP_BY_KEY, isChatGroupMode, type ChatGroupMode } from './sidebar-view';

const VIEW_EVENT = 'o8:chat-view-changed';
const listeners = new Set<() => void>();
const attentionSources = new Map<string, number>();
let transientView: ChatGroupMode | null = null;
function subscribeView(listener: () => void) {
  window.addEventListener(VIEW_EVENT, listener);
  window.addEventListener('storage', listener);
  return () => { window.removeEventListener(VIEW_EVENT, listener); window.removeEventListener('storage', listener); };
}
function getView(): ChatGroupMode {
  try { const stored = localStorage.getItem(CHAT_GROUP_BY_KEY); return isChatGroupMode(stored) ? stored : 'chronological'; } catch { /* Restricted storage. */ }
  return transientView ?? 'chronological';
}
export function setSidebarView(mode: ChatGroupMode) {
  transientView = mode;
  try { localStorage.setItem(CHAT_GROUP_BY_KEY, mode); } catch { /* Keep navigation usable. */ }
  window.dispatchEvent(new Event(VIEW_EVENT));
}
export function useSidebarView() {
  return useSyncExternalStore(subscribeView, getView, () => 'chronological' as ChatGroupMode);
}
function emitAttention() { listeners.forEach((listener) => listener()); }
function subscribeAttention(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function usePublishSidebarAttention(count: number, enabled = true) {
  const id = useId();
  useEffect(() => {
    if (!enabled) return;
    attentionSources.set(id, count); emitAttention();
    return () => { attentionSources.delete(id); emitAttention(); };
  }, [count, enabled, id]);
}
export function useSidebarAttention() {
  return useSyncExternalStore(subscribeAttention, () => [...attentionSources.values()].some((count) => count > 0), () => false);
}
