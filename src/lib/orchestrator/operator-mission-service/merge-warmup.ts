type MergeModule = typeof import('./merge');

let mergeModulePromise: Promise<MergeModule> | null = null;
let mergeWarmupPromise: Promise<void> | null = null;
let mergeReady = false;
let mergeError: string | null = null;

export function loadMergeModule() {
  mergeModulePromise ??= import('./merge').catch((error) => {
    mergeModulePromise = null;
    throw error;
  });
  return mergeModulePromise;
}

export function prewarmMergePath() {
  if (mergeReady) return Promise.resolve();
  mergeWarmupPromise ??= loadMergeModule()
    .then((module) => module.warmMergePath())
    .then(() => {
      mergeReady = true;
      mergeError = null;
    })
    .catch((error) => {
      mergeWarmupPromise = null;
      mergeError = error instanceof Error ? error.message : String(error);
      throw error;
    });
  return mergeWarmupPromise;
}

export function getMergeWarmupSnapshot() {
  return {
    ready: mergeReady,
    warming: Boolean(mergeWarmupPromise) && !mergeReady,
    error: mergeError,
  };
}
