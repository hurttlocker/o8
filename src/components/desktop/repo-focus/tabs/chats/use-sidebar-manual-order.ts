'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createDragAutoScroll } from '@/lib/ui/drag-auto-scroll';
import { toast } from '@/components/shared/ConfirmToastHost';
import { THREAD_DRAG_START_EVENT, THREAD_DRAG_MOVE_EVENT, THREAD_DRAG_END_EVENT, THREAD_DRAG_CANCEL_EVENT,
  type ThreadDragPayload, type ThreadDragStartDetail, type ThreadDragPoint } from '@/lib/workspace-terminal/thread-drag';
import { setSidebarView } from './sidebar-view-store';
import type { ChatHistoryItem } from './types';

export const SIDEBAR_MANUAL_ORDER_KEY = 'o8:sidebar-manual-order:v1';
export interface SidebarInsertion { id: string; after: boolean }
function readOrder(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(SIDEBAR_MANUAL_ORDER_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string').slice(0, 5000) : [];
  } catch { return []; }
}
export function orderSidebarChats(items: ChatHistoryItem[], order: string[]): ChatHistoryItem[] {
  const rank = new Map(order.map((id, index) => [id, index]));
  return items.map((item, index) => ({ item, rank: rank.get(item.tabId) ?? order.length + index }))
    .sort((a, b) => a.rank - b.rank).map(entry => entry.item);
}
function insertionAt(point: ThreadDragPoint): SidebarInsertion | null {
  const row = document.elementFromPoint?.(point.clientX, point.clientY)?.closest<HTMLElement>('[data-sidebar-chat-id]');
  if (!row) return null;
  const rect = row.getBoundingClientRect();
  return { id: row.dataset.sidebarChatId!, after: point.clientY >= rect.top + rect.height / 2 };
}
export function useSidebarManualOrder(items: ChatHistoryItem[]) {
  const [order, setOrder] = useState(readOrder);
  const [insertion, setInsertion] = useState<SidebarInsertion | null>(null);
  const latest = useRef({ items, order });
  useEffect(() => { latest.current = { items, order }; }, [items, order]);
  const move = useCallback((from: string, target: SidebarInsertion) => {
    const { items: source, order: saved } = latest.current;
    const moving = source.find(item => item.tabId === from);
    const anchor = source.find(item => item.tabId === target.id);
    if (!moving || !anchor || from === anchor.tabId) return;
    if (Boolean(moving.pinned) !== Boolean(anchor.pinned)) {
      toast('Pinned chats stay in Pinned. Unpin the chat to move it into Recents.'); return;
    }
    const ids = orderSidebarChats(source, saved).map(item => item.tabId).filter(id => id !== from);
    ids.splice(ids.indexOf(target.id) + Number(target.after), 0, from);
    const next = [...ids, ...saved.filter(id => !ids.includes(id))].slice(0, 5000);
    try { localStorage.setItem(SIDEBAR_MANUAL_ORDER_KEY, JSON.stringify(next)); }
    catch { toast('Could not save chat order.'); return; }
    setOrder(next); setSidebarView('manual');
  }, []);
  useEffect(() => {
    let dragging: ThreadDragPayload | null = null;
    const start = (event: Event) => { dragging = (event as CustomEvent<ThreadDragStartDetail>).detail?.payload ?? null; };
    const updateInsertion = (point: ThreadDragPoint) => {
      let next = insertionAt(point);
      const source = latest.current.items.find(item => item.tabId === dragging?.sidebarItemId);
      const target = latest.current.items.find(item => item.tabId === next?.id);
      if (!source || !target || source === target || Boolean(source.pinned) !== Boolean(target.pinned)) next = null;
      setInsertion(current => current?.id === next?.id && current?.after === next?.after ? current : next);
    };
    const scroll = createDragAutoScroll('y', updateInsertion);
    const update = (event: Event) => {
      if (!dragging?.sidebarItemId) return;
      const point = (event as CustomEvent<ThreadDragPoint>).detail;
      updateInsertion(point); scroll.update(point);
    };
    const end = (event: Event) => {
      scroll.stop();
      const from = dragging?.sidebarItemId;
      const target = insertionAt((event as CustomEvent<ThreadDragPoint>).detail);
      dragging = null; setInsertion(null);
      if (from && target) move(from, target);
    };
    const cancel = () => { scroll.stop(); dragging = null; setInsertion(null); };
    const storage = (event: StorageEvent) => { if (event.key === null || event.key === SIDEBAR_MANUAL_ORDER_KEY) setOrder(readOrder()); };
    window.addEventListener(THREAD_DRAG_START_EVENT, start);
    window.addEventListener(THREAD_DRAG_MOVE_EVENT, update);
    window.addEventListener(THREAD_DRAG_END_EVENT, end);
    window.addEventListener(THREAD_DRAG_CANCEL_EVENT, cancel);
    window.addEventListener('storage', storage);
    return () => {
      scroll.stop();
      window.removeEventListener(THREAD_DRAG_START_EVENT, start);
      window.removeEventListener(THREAD_DRAG_MOVE_EVENT, update);
      window.removeEventListener(THREAD_DRAG_END_EVENT, end);
      window.removeEventListener(THREAD_DRAG_CANCEL_EVENT, cancel);
      window.removeEventListener('storage', storage);
    };
  }, [move]);
  const orderedItems = useMemo(() => orderSidebarChats(items, order), [items, order]);
  return { orderedItems, insertion, move };
}
