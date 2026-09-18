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
}

export const JUDGMENT_PROVIDER_FALLBACK: JudgmentProviderDefault = {
  judgmentProvider: 'off',
};

export function resolveStoredJudgmentProvider(
  stored: Partial<JudgmentProviderDefault>,
): Partial<JudgmentProviderDefault> {
  return isJudgmentProvider(stored.judgmentProvider)
    ? { judgmentProvider: stored.judgmentProvider }
    : {};
}

export function resolveJudgmentProviderSettings(file: Partial<JudgmentProviderDefault>) {
  return {
    values: {
      judgmentProvider: file.judgmentProvider ?? JUDGMENT_PROVIDER_FALLBACK.judgmentProvider,
    },
    sources: {
      judgmentProvider: file.judgmentProvider !== undefined ? 'file' as const : 'default' as const,
    },
  };
}

export function applyJudgmentProviderUpdate(
  stored: Partial<JudgmentProviderDefault>,
  update: Partial<JudgmentProviderDefault>,
): void {
  if (update.judgmentProvider === undefined) return;
  if (!isJudgmentProvider(update.judgmentProvider)) {
    throw new Error(`judgmentProvider must be ${JUDGMENT_PROVIDER_VALUES_MESSAGE}.`);
  }
  stored.judgmentProvider = update.judgmentProvider;
}
