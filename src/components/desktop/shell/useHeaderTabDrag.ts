'use client';

import { useEffect, useRef, useState, type PointerEvent, type RefObject } from 'react';
import { createDragAutoScroll } from '@/lib/ui/drag-auto-scroll';
import { trackThreadDrag, THREAD_DRAG_MOVE_EVENT, THREAD_DRAG_END_EVENT, THREAD_DRAG_CANCEL_EVENT,
  type ThreadDragPoint } from '@/lib/workspace-terminal/thread-drag';

export interface DraggableHeaderTab {
  id: string; label: string; kind: string; orchestratorThreadId?: string | null; repoPath?: string | null;
}

/** Pointer-based tab sorting and saved-chat pane drops, including native WebKit. */
export function useHeaderTabDrag(host: RefObject<HTMLDivElement | null>, tabs: DraggableHeaderTab[], workspaceId?: string | null) {
  const [insertion, setInsertion] = useState<{ id: string; after: boolean } | null>(null);
  const consumed = useRef(false);
  const dispose = useRef<(() => void) | null>(null);
  const sourceId = useRef<string | null>(null);
  useEffect(() => () => dispose.current?.(), []);
  useEffect(() => {
    const targetAt = (point: ThreadDragPoint) => {
      const row = document.elementFromPoint?.(point.clientX, point.clientY)?.closest<HTMLElement>('[data-o8-workspace-tab]');
      if (!row || !host.current?.contains(row) || row.dataset.o8WorkspaceTab === sourceId.current) return null;
      const rect = row.getBoundingClientRect();
      return { id: row.dataset.o8WorkspaceTab!, after: point.clientX >= rect.left + rect.width / 2 };
    };
    const updateInsertion = (point: ThreadDragPoint) => {
      const next = targetAt(point);
      setInsertion(current => current?.id === next?.id && current?.after === next?.after ? current : next);
    };
    const scroll = createDragAutoScroll('x', updateInsertion, host.current);
    const move = (event: Event) => {
      if (!sourceId.current) return;
      const point = (event as CustomEvent<ThreadDragPoint>).detail;
      updateInsertion(point); scroll.update(point);
    };
    const end = (event: Event) => {
      if (!sourceId.current) return;
      scroll.stop();
      const target = targetAt((event as CustomEvent<ThreadDragPoint>).detail);
      const from = sourceId.current; sourceId.current = null; setInsertion(null);
      if (target) window.dispatchEvent(new CustomEvent('o8:request-reorder-tabs', {
        detail: { workspaceId: workspaceId ?? null, tabId: from, targetId: target.id, after: target.after },
      }));
    };
    const cancel = () => { scroll.stop(); sourceId.current = null; setInsertion(null); };
    window.addEventListener(THREAD_DRAG_MOVE_EVENT, move);
    window.addEventListener(THREAD_DRAG_END_EVENT, end);
    window.addEventListener(THREAD_DRAG_CANCEL_EVENT, cancel);
    return () => {
      scroll.stop();
      window.removeEventListener(THREAD_DRAG_MOVE_EVENT, move);
      window.removeEventListener(THREAD_DRAG_END_EVENT, end);
      window.removeEventListener(THREAD_DRAG_CANCEL_EVENT, cancel);
    };
  }, [host, workspaceId]);
  const onPointerDownCapture = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !event.isPrimary || (event.target as Element).closest('button,input,textarea')) return;
    const element = (event.target as Element).closest<HTMLElement>('[data-o8-workspace-tab]');
    const tab = tabs.find(item => item.id === element?.dataset.o8WorkspaceTab);
    if (!tab || !element) return;
    event.stopPropagation(); dispose.current?.(); consumed.current = false;
    const threadId = tab.orchestratorThreadId || (tab.kind === 'llm-chat' ? tab.id.replace(/^llm-chat:/, '') : '');
    dispose.current = trackThreadDrag(event, { threadId, title: tab.label, tabId: tab.id, workspaceId,
      mode: tab.kind === 'orchestrator' ? 'orchestrator' : 'chat', repoPath: tab.repoPath, navigationOnly: !threadId },
    { source: element, onActivate: () => { consumed.current = true; sourceId.current = tab.id; } });
  };
  return { insertion, onPointerDownCapture, onClickCapture: (event: React.MouseEvent<HTMLDivElement>) => {
    if (!consumed.current || event.detail === 0) return;
    event.preventDefault(); event.stopPropagation(); consumed.current = false;
  } };
}
