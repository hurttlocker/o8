// Keep in sync with src-tauri/src/models.rs.

export const RAW_MODEL_IDS = {
  anthropicClaudeFable5: 'claude-fable-5',
  anthropicClaudeFable5OneMillion: 'claude-fable-5[1m]',
  anthropicClaudeOpus5: 'claude-opus-5',
  anthropicClaudeOpus48: 'claude-opus-4-8',
  anthropicClaudeOpus47: 'claude-opus-4-7',
  anthropicClaudeOpus46: 'claude-opus-4-6',
  anthropicClaudeSonnet5: 'claude-sonnet-5',
  anthropicClaudeSonnet46: 'claude-sonnet-4-6',
  anthropicClaudeSonnet45: 'claude-sonnet-4-5',
  anthropicClaudeHaiku45: 'claude-haiku-4-5',
  anthropicClaudeHaiku45Dated: 'claude-haiku-4-5-20251001',
  openAiGpt56Sol: 'gpt-5.6-sol',
  openAiGpt56Terra: 'gpt-5.6-terra',
  openAiGpt56Luna: 'gpt-5.6-luna',
  openAiGpt55: 'gpt-5.5',
  openAiGpt54: 'gpt-5.4',
  openAiGpt53Codex: 'gpt-5.3-codex',
  openAiGpt4o: 'gpt-4o',
  opencodeGpt5Nano: 'opencode/gpt-5-nano',
  xaiGrok45: 'grok-4.5',
  gemini25Flash: 'gemini-2.5-flash',
  gemini3FlashPreview: 'gemini-3-flash-preview',
  gemini31ProPreview: 'gemini-3.1-pro-preview',
  gemini3ProPreview: 'gemini-3-pro-preview',
} as const;

export const MODEL_IDS = {
  orchestratorDefault: RAW_MODEL_IDS.anthropicClaudeOpus48,
  // Codex ORCHESTRATOR default (flagship, Opus-class) — the "just like 5.5 xhigh"
  // slot, flipped to the 5.6 generation 2026-07-09. gpt-5.5 remains pickable.
  codexDefault: RAW_MODEL_IDS.openAiGpt56Sol,
  // Codex WORKER default (Sonnet-class, ~half Sol's price) for dispatched packets.
  codexWorkerDefault: RAW_MODEL_IDS.openAiGpt56Terra,
  // Codex SCOUT / cheap tier (Haiku-class) for triage-style work.
  codexScoutDefault: RAW_MODEL_IDS.openAiGpt56Luna,
  codexCliDefault: RAW_MODEL_IDS.openAiGpt56Sol,
  claudeWorkerDefault: RAW_MODEL_IDS.anthropicClaudeSonnet5,
  claudeQaDefault: RAW_MODEL_IDS.anthropicClaudeSonnet5,
  claudeReviewDefault: RAW_MODEL_IDS.anthropicClaudeSonnet5,
  claudeHaikuQaDefault: RAW_MODEL_IDS.anthropicClaudeHaiku45Dated,
  fableDefault: RAW_MODEL_IDS.anthropicClaudeFable5,
  opencodeDefault: RAW_MODEL_IDS.opencodeGpt5Nano,
  // Grok Build CLI worker default (Opus-class, cheaper for context) — sub-billed
  // via SuperGrok through the CLI adapter, not a metered API route.
  grokWorkerDefault: RAW_MODEL_IDS.xaiGrok45,
  mobileOpenAiDefault: RAW_MODEL_IDS.openAiGpt56Sol,
  mobileCliDefault: `cli:codex:${RAW_MODEL_IDS.openAiGpt56Sol}`,
  mobileGeminiDefault: RAW_MODEL_IDS.gemini25Flash,
  raw: RAW_MODEL_IDS,
} as const;

export const CROSS_HOUSE_MODEL_TIERS = {
  frontierOrchestrator: {
    anthropic: RAW_MODEL_IDS.anthropicClaudeOpus48,
    openai: RAW_MODEL_IDS.openAiGpt56Sol,
  },
  reviewMechanical: {
    anthropic: RAW_MODEL_IDS.anthropicClaudeSonnet5,
    openai: RAW_MODEL_IDS.openAiGpt56Terra,
  },
  scout: {
    anthropic: RAW_MODEL_IDS.anthropicClaudeHaiku45Dated,
    openai: RAW_MODEL_IDS.openAiGpt56Luna,
  },
} as const;

export type ModelId = typeof RAW_MODEL_IDS[keyof typeof RAW_MODEL_IDS];
