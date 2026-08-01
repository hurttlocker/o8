import 'server-only';

export interface AppUpdateState {
  updatePending: boolean;
  version: string | null;
  updatedAt: string | null;
}

let state: AppUpdateState = {
  updatePending: false,
  version: null,
  updatedAt: null,
};

export function getAppUpdateState(): AppUpdateState {
  return state;
}

export function setAppUpdateState(update: { updatePending: boolean; version?: string | null }): AppUpdateState {
  state = {
    updatePending: update.updatePending,
    version: update.updatePending ? update.version ?? null : null,
    updatedAt: new Date().toISOString(),
  };
  return state;
}
