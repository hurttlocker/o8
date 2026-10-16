'use client';
import { useEffect, type RefObject } from 'react';

export function useScratchDialog(open: boolean, dialog: RefObject<HTMLDivElement | null>, trigger: RefObject<HTMLDivElement | null>, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const launcher = trigger.current;
    const handle = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
      if (event.key !== 'Tab') return;
      const nodes = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]), textarea:not([disabled]), input:not([disabled]), a[href], [tabindex="0"]') ?? []).filter((node) => !node.closest('[hidden], [inert]'));
      const first = nodes[0]; const last = nodes.at(-1);
      if (!first || !last) return;
      if (!dialog.current?.contains(document.activeElement) || event.shiftKey && document.activeElement === first) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', handle, true);
    return () => {
      window.removeEventListener('keydown', handle, true);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
      else launcher?.querySelector<HTMLElement>('textarea, button')?.focus({ preventScroll: true });
    };
  }, [open, close, dialog, trigger]);
}
