'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export interface DesignModeSelection {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DesignModeState {
  active: boolean;
  selection: DesignModeSelection | null;
}

export interface UseDesignModeResult {
  state: DesignModeState;
  toggle: () => void;
  close: () => void;
  setSelection: (selection: DesignModeSelection | null) => void;
  clearSelection: () => void;
  captureRequestId: number;
}

function hasSelection(selection: DesignModeSelection | null): selection is DesignModeSelection {
  return Boolean(selection && selection.width >= 6 && selection.height >= 6);
}

export function useDesignMode(): UseDesignModeResult {
  const [state, setState] = useState<DesignModeState>({
    active: false,
    selection: null,
  });
  const [captureRequestId, setCaptureRequestId] = useState(0);
  const activeRef = useRef(state.active);
  const selectionRef = useRef(state.selection);

  useEffect(() => {
    activeRef.current = state.active;
    selectionRef.current = state.selection;
  }, [state.active, state.selection]);

  const close = useCallback(() => {
    setState({
      active: false,
      selection: null,
    });
  }, []);

  const toggle = useCallback(() => {
    setState((current) => current.active
      ? {
          active: false,
          selection: null,
        }
      : {
          active: true,
          selection: null,
        });
  }, []);

  const setSelection = useCallback((selection: DesignModeSelection | null) => {
    setState((current) => ({
      ...current,
      selection,
    }));
  }, []);

  const clearSelection = useCallback(() => {
    setState((current) => ({
      ...current,
      selection: null,
    }));
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();

      if (event.metaKey && event.shiftKey && key === 'd') {
        event.preventDefault();
        if (!event.repeat) {
          toggle();
        }
        return;
      }

      if (!activeRef.current) {
        return;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        if (!event.repeat) {
          close();
        }
        return;
      }

      if (event.metaKey && !event.shiftKey && key === 'l') {
        event.preventDefault();
        if (!event.repeat && hasSelection(selectionRef.current)) {
          setCaptureRequestId((current) => current + 1);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [close, toggle]);

  return {
    state,
    toggle,
    close,
    setSelection,
    clearSelection,
    captureRequestId,
  };
}
