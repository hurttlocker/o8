import 'server-only';

export interface AppUpdateState {
  updatePending: boolean;
  version: string | null;
  updatedAt: string | null;
  check: AppUpdateCheckState;
}

export type AppUpdateCheckOutcome = 'never' | 'available' | 'current' | 'failed';

export interface AppUpdateCheckState {
  outcome: AppUpdateCheckOutcome;
  checkedAt: string | null;
  errorCode: 'update_check_not_run' | 'update_check_failed' | null;
  error: string | null;
}

const NEVER_CHECKED_MESSAGE = 'No updater check has completed since the app server started.';

let state: AppUpdateState = {
  updatePending: false,
  version: null,
  updatedAt: null,
  check: {
    outcome: 'never',
    checkedAt: null,
    errorCode: 'update_check_not_run',
    error: NEVER_CHECKED_MESSAGE,
  },
};

export function getAppUpdateState(): AppUpdateState {
  return state;
}

export function setAppUpdateState(update: {
  updatePending: boolean;
  version?: string | null;
  checkOutcome?: AppUpdateCheckOutcome;
  checkedAt?: string | null;
  checkError?: string | null;
}): AppUpdateState {
  const outcome = update.checkOutcome ?? (update.updatePending ? 'available' : 'current');
  const checkedAt = outcome === 'never' ? null : update.checkedAt ?? new Date().toISOString();
  if (state.check.outcome !== 'never') {
    if (outcome === 'never') return state;
    const previousCheckMs = Date.parse(state.check.checkedAt ?? '');
    const nextCheckMs = Date.parse(checkedAt ?? '');
    if (Number.isFinite(previousCheckMs) && Number.isFinite(nextCheckMs) && nextCheckMs < previousCheckMs) {
      return state;
    }
  }
  const error = outcome === 'never'
    ? NEVER_CHECKED_MESSAGE
    : outcome === 'failed'
      ? update.checkError?.trim().slice(0, 1_000) || 'The updater check failed without an error message.'
      : null;
  state = {
    updatePending: update.updatePending,
    version: update.updatePending ? update.version ?? null : null,
    updatedAt: new Date().toISOString(),
    check: {
      outcome,
      checkedAt,
      errorCode: outcome === 'never'
        ? 'update_check_not_run'
        : outcome === 'failed'
          ? 'update_check_failed'
          : null,
      error,
    },
  };
  return state;
}
