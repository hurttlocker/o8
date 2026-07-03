'use client';

export interface ActiveLongLivedRequestController {
  begin: () => AbortController;
  finish: (controller: AbortController) => void;
  abort: (reason?: string) => void;
  setActive: (active: boolean) => void;
  getCurrent: () => AbortController | null;
}

export function createActiveLongLivedRequestController(initialActive = true): ActiveLongLivedRequestController {
  let active = initialActive;
  let current: AbortController | null = null;

  const abort = (reason = 'inactive') => {
    const controller = current;
    current = null;
    if (!controller || controller.signal.aborted) return;
    controller.abort(reason);
  };

  return {
    begin() {
      abort('replaced');
      const controller = new AbortController();
      current = controller;
      if (!active) {
        abort('inactive');
      }
      return controller;
    },
    finish(controller) {
      if (current === controller) {
        current = null;
      }
    },
    abort,
    setActive(nextActive) {
      active = nextActive;
      if (!active) abort('inactive');
    },
    getCurrent() {
      return current;
    },
  };
}

export function isAbortError(error: unknown): boolean {
  return (error as { name?: string } | null)?.name === 'AbortError';
}
