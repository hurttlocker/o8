'use client';

import { normalizeUpdateInfo, type UpdateCheckReport, type UpdateInfo } from './update-card-view';

/** Polling only reads recorded state. Native code owns all scheduled checks. */
export function subscribeRecordedUpdate(onState: (info: UpdateInfo | null, check: UpdateCheckReport) => void) {
  let cancelled = false;
  let latest = '';
  const controller = new AbortController();
  const read = async () => {
    try {
      const response = await fetch('/api/panel/app/update-state', { cache: 'no-store', signal: controller.signal });
      if (!response.ok || cancelled) return;
      const { state } = await response.json() as { state?: { updatePending: boolean; version: string | null;
        info?: Record<string, unknown> | null; check: UpdateCheckReport } };
      if (!state?.check || state.check.outcome === 'never' || cancelled) return;
      const key = JSON.stringify(state);
      if (key === latest) return;
      latest = key;
      onState(state.updatePending ? normalizeUpdateInfo({ ...state.info, version: state.version }) : null, state.check);
    } catch { /* Native results are replayed when the server reconnects. */ }
  };
  void read();
  const timer = window.setInterval(() => void read(), 5_000);
  return () => { cancelled = true; controller.abort(); window.clearInterval(timer); };
}
