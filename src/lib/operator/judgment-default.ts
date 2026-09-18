/**
 * `judgment.provider` (#2434): which typed judgment provider o8 may ask about
 * diffs, questions, and incidents. Off by default. When on, the judgment
 * client sends the sanitized diff text to that provider, so the only way to
 * turn it on is an explicit operator write (Settings, the TOML file, or the
 * gated operator-defaults route).
 */
export type JudgmentProvider = 'off' | 'typesafe' | 'managed';

export const JUDGMENT_PROVIDER_VALUES_MESSAGE = 'one of "off", "typesafe", or "managed"';

export function isJudgmentProvider(value: unknown): value is JudgmentProvider {
  return value === 'off' || value === 'typesafe' || value === 'managed';
}

export interface JudgmentProviderDefault {
  judgmentProvider: JudgmentProvider;
  /**
   * `judgment.managed_option_visible` (#2485): shows Managed in the Settings
   * row. Off until the hosted endpoint exists, so the app never offers a
   * choice that fails. It only hides the option; it never gates the value.
   */
  judgmentManagedOptionVisible: boolean;
}

export const JUDGMENT_PROVIDER_FALLBACK: JudgmentProviderDefault = {
  judgmentProvider: 'off',
  judgmentManagedOptionVisible: false,
};

export function resolveStoredJudgmentProvider(
  stored: Partial<JudgmentProviderDefault>,
): Partial<JudgmentProviderDefault> {
  const result: Partial<JudgmentProviderDefault> = {};
  if (isJudgmentProvider(stored.judgmentProvider)) result.judgmentProvider = stored.judgmentProvider;
  if (typeof stored.judgmentManagedOptionVisible === 'boolean') {
    result.judgmentManagedOptionVisible = stored.judgmentManagedOptionVisible;
  }
  return result;
}

export function resolveJudgmentProviderSettings(file: Partial<JudgmentProviderDefault>) {
  return {
    values: {
      judgmentProvider: file.judgmentProvider ?? JUDGMENT_PROVIDER_FALLBACK.judgmentProvider,
      judgmentManagedOptionVisible: file.judgmentManagedOptionVisible ?? JUDGMENT_PROVIDER_FALLBACK.judgmentManagedOptionVisible,
    },
    sources: {
      judgmentProvider: file.judgmentProvider !== undefined ? 'file' as const : 'default' as const,
      judgmentManagedOptionVisible: file.judgmentManagedOptionVisible !== undefined ? 'file' as const : 'default' as const,
    },
  };
}

export function applyJudgmentProviderUpdate(
  stored: Partial<JudgmentProviderDefault>,
  update: Partial<JudgmentProviderDefault>,
): void {
  if (update.judgmentManagedOptionVisible !== undefined) {
    if (typeof update.judgmentManagedOptionVisible !== 'boolean') {
      throw new Error('judgmentManagedOptionVisible must be boolean.');
    }
    stored.judgmentManagedOptionVisible = update.judgmentManagedOptionVisible;
  }
  if (update.judgmentProvider === undefined) return;
  if (!isJudgmentProvider(update.judgmentProvider)) {
    throw new Error(`judgmentProvider must be ${JUDGMENT_PROVIDER_VALUES_MESSAGE}.`);
  }
  stored.judgmentProvider = update.judgmentProvider;
}
