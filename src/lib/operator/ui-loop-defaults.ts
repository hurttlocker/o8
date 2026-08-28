export interface UiLoopDefaults {
  uiLoopMaxIterations: number;
  uiLoopMaxMinutes: number;
  uiLoopMaxDiffBytes: number;
  uiLoopMaxDiffFiles: number;
}

export const UI_LOOP_FALLBACK: UiLoopDefaults = {
  uiLoopMaxIterations: 8,
  uiLoopMaxMinutes: 30,
  uiLoopMaxDiffBytes: 65_536,
  uiLoopMaxDiffFiles: 12,
};

function positiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

export function resolveStoredUiLoopDefaults(value: Partial<UiLoopDefaults>): Partial<UiLoopDefaults> {
  const result: Partial<UiLoopDefaults> = {};
  for (const field of Object.keys(UI_LOOP_FALLBACK) as Array<keyof UiLoopDefaults>) {
    const normalized = positiveInteger(value[field]);
    if (normalized !== undefined) result[field] = normalized;
  }
  return result;
}

export function resolveUiLoopSettings(file: Partial<UiLoopDefaults>) {
  const stored = resolveStoredUiLoopDefaults(file);
  return {
    values: {
      uiLoopMaxIterations: stored.uiLoopMaxIterations ?? UI_LOOP_FALLBACK.uiLoopMaxIterations,
      uiLoopMaxMinutes: stored.uiLoopMaxMinutes ?? UI_LOOP_FALLBACK.uiLoopMaxMinutes,
      uiLoopMaxDiffBytes: stored.uiLoopMaxDiffBytes ?? UI_LOOP_FALLBACK.uiLoopMaxDiffBytes,
      uiLoopMaxDiffFiles: stored.uiLoopMaxDiffFiles ?? UI_LOOP_FALLBACK.uiLoopMaxDiffFiles,
    },
    sources: {
      uiLoopMaxIterations: stored.uiLoopMaxIterations === undefined ? 'default' as const : 'file' as const,
      uiLoopMaxMinutes: stored.uiLoopMaxMinutes === undefined ? 'default' as const : 'file' as const,
      uiLoopMaxDiffBytes: stored.uiLoopMaxDiffBytes === undefined ? 'default' as const : 'file' as const,
      uiLoopMaxDiffFiles: stored.uiLoopMaxDiffFiles === undefined ? 'default' as const : 'file' as const,
    },
  };
}

export function applyUiLoopUpdate(stored: Partial<UiLoopDefaults>, update: Partial<UiLoopDefaults>): void {
  for (const field of Object.keys(UI_LOOP_FALLBACK) as Array<keyof UiLoopDefaults>) {
    if (update[field] === undefined) continue;
    const normalized = positiveInteger(update[field]);
    if (normalized === undefined) throw new Error(`${field} must be a positive integer.`);
    stored[field] = normalized;
  }
}
