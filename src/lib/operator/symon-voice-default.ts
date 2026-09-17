export interface SymonVoiceDefault {
  /** Never fall back from ChatGPT OAuth to a metered OpenAI API key for Symon voice. */
  symonVoiceSubscriptionOnly: boolean;
}

export const SYMON_VOICE_FALLBACK: SymonVoiceDefault = {
  symonVoiceSubscriptionOnly: false,
};

export function resolveStoredSymonVoice(
  stored: Partial<SymonVoiceDefault>,
): Partial<SymonVoiceDefault> {
  return typeof stored.symonVoiceSubscriptionOnly === 'boolean'
    ? { symonVoiceSubscriptionOnly: stored.symonVoiceSubscriptionOnly }
    : {};
}

export function resolveSymonVoiceSettings(file: Partial<SymonVoiceDefault>) {
  return {
    values: {
      symonVoiceSubscriptionOnly:
        file.symonVoiceSubscriptionOnly ?? SYMON_VOICE_FALLBACK.symonVoiceSubscriptionOnly,
    },
    sources: {
      symonVoiceSubscriptionOnly:
        file.symonVoiceSubscriptionOnly !== undefined ? 'file' as const : 'default' as const,
    },
  };
}

export function applySymonVoiceUpdate(
  stored: Partial<SymonVoiceDefault>,
  update: Partial<SymonVoiceDefault>,
): void {
  if (update.symonVoiceSubscriptionOnly !== undefined) {
    stored.symonVoiceSubscriptionOnly = Boolean(update.symonVoiceSubscriptionOnly);
  }
}
