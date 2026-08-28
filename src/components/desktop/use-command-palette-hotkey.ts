'use client';

import { useEffect, type Dispatch, type SetStateAction } from 'react';

export function useCommandPaletteHotkey(
  setOpen: Dispatch<SetStateAction<boolean>>,
): void {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const isPaletteShortcut = (event.metaKey || event.ctrlKey)
        && !event.altKey
        && !event.shiftKey
        && event.key.toLowerCase() === 'k';
      if (!isPaletteShortcut) return;

      const target = event.target;
      const insideTerminal = target instanceof Element
        && Boolean(target.closest('.xterm, .cortex-terminal-fade'));
      if (insideTerminal) return;

      event.preventDefault();
      event.stopPropagation();
      setOpen((current) => !current);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [setOpen]);
}
