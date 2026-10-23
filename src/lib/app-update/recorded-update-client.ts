'use client';

import { normalizeUpdateInfo, type UpdateCheckReport, type UpdateInfo } from './update-card-view';
import type { AppUpdateAutoApplyState } from './relaunch-state';

/** An explicit request uses the same native scheduler as periodic checks. It never installs. */
export async function requestFreshAppUpdateCheck(): Promise<{ info: UpdateInfo | null; check: UpdateCheckReport }> {
  const response = await fetch('/api/panel/update/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ checkOnly: true }), signal: AbortSignal.timeout(35_000) });
  const payload = await response.json();
  if (!response.ok || payload.ok !== true) throw new Error(payload.error?.message ?? 'The update check could not finish. Try again.');
  const state = payload.state;
  if (!state?.check || !['available', 'current'].includes(state.check.outcome)) throw new Error('The update check returned no verified result.');
  const info = state.updatePending ? normalizeUpdateInfo({ ...state.info, version: state.version }) : null;
  if (state.updatePending && !info) throw new Error('The update check returned no update version.');
  return { info, check: state.check };
}

/** Polling only reads recorded state. Native code owns all scheduled checks. */
export function subscribeRecordedUpdate(onState: (info: UpdateInfo | null, check: UpdateCheckReport,
  activity?: AppUpdateAutoApplyState | null) => void) {
  let cancelled = false;
  let latest = '';
  const controller = new AbortController();
  const read = async () => {
    try {
      const response = await fetch('/api/panel/app/update-state', { cache: 'no-store', signal: controller.signal });
      if (!response.ok || cancelled) return;
      const { state } = await response.json() as { state?: { updatePending: boolean; version: string | null;
        info?: Record<string, unknown> | null; check: UpdateCheckReport; autoApply?: AppUpdateAutoApplyState | null } };
      if (!state?.check || state.check.outcome === 'never' || cancelled) return;
      const key = JSON.stringify(state);
      if (key === latest) return;
      latest = key;
      onState(state.updatePending ? normalizeUpdateInfo({ ...state.info, version: state.version }) : null,
        state.check, state.autoApply);
    } catch { /* Native results are replayed when the server reconnects. */ }
  };
  void read();
  const timer = window.setInterval(() => void read(), 5_000);
  return () => { cancelled = true; controller.abort(); window.clearInterval(timer); };
}
