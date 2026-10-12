export interface CodexAppThreadsDefault {
  /**
   * Run Codex orchestrator conversations in the operator's own Codex home so
   * they appear in the Codex app on desktop and mobile (#3573). Off keeps them
   * in o8's private Codex home.
   */
  codexAppThreads: boolean;
}

export const CODEX_APP_THREADS_FALLBACK: CodexAppThreadsDefault = {
  codexAppThreads: false,
};

export function resolveStoredCodexAppThreads(
  stored: Partial<CodexAppThreadsDefault>,
): Partial<CodexAppThreadsDefault> {
  return typeof stored.codexAppThreads === 'boolean'
    ? { codexAppThreads: stored.codexAppThreads }
    : {};
}

export function applyCodexAppThreadsUpdate(
  stored: Partial<CodexAppThreadsDefault>,
  update: Partial<CodexAppThreadsDefault>,
): void {
  if (update.codexAppThreads !== undefined) {
    stored.codexAppThreads = Boolean(update.codexAppThreads);
  }
}
