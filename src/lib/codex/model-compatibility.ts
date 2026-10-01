import { MODEL_IDS } from '@/lib/models';

export const CODEX_SOL_FALLBACK_MODEL = MODEL_IDS.raw.openAiGpt56Sol;
export const CODEX_SOL_UPDATE_NOTICE = 'GPT-6.1 Sol is unavailable in this Codex CLI. Using GPT-5.6 Sol for this turn. Update the Codex CLI in Settings to enable GPT-6.1 Sol.';

/** Only the verified pre-turn rejection permits a compatibility retry. */
export function isCodexSolUnsupported(model: string | undefined, diagnostic: string): boolean {
  return model === MODEL_IDS.raw.openAiGpt61Sol
    && /The ['"]gpt-6\.1-sol['"] model is not supported when using Codex with a ChatGPT account\./i.test(diagnostic);
}

export function codexSolCompatibilityFallback(model: string | undefined, diagnostic: string) {
  return isCodexSolUnsupported(model, diagnostic)
    ? { nextModel: CODEX_SOL_FALLBACK_MODEL, notice: CODEX_SOL_UPDATE_NOTICE } : null;
}
