// Keep in sync with src-tauri/src/models.rs.

export const RAW_MODEL_IDS = {
  anthropicClaudeFable5: 'claude-fable-5',
  anthropicClaudeFable5OneMillion: 'claude-fable-5[1m]',
  anthropicClaudeOpus48: 'claude-opus-4-8',
  anthropicClaudeOpus47: 'claude-opus-4-7',
  anthropicClaudeOpus46: 'claude-opus-4-6',
  anthropicClaudeSonnet5: 'claude-sonnet-5',
  anthropicClaudeSonnet46: 'claude-sonnet-4-6',
  anthropicClaudeSonnet45: 'claude-sonnet-4-5',
  anthropicClaudeHaiku45: 'claude-haiku-4-5',
  anthropicClaudeHaiku45Dated: 'claude-haiku-4-5-20251001',
  openAiGpt55: 'gpt-5.5',
  openAiGpt54: 'gpt-5.4',
  openAiGpt53Codex: 'gpt-5.3-codex',
  openAiGpt4o: 'gpt-4o',
  opencodeGpt5Nano: 'opencode/gpt-5-nano',
  gemini25Flash: 'gemini-2.5-flash',
  gemini3FlashPreview: 'gemini-3-flash-preview',
  gemini31ProPreview: 'gemini-3.1-pro-preview',
  gemini3ProPreview: 'gemini-3-pro-preview',
} as const;

export const MODEL_IDS = {
  orchestratorDefault: RAW_MODEL_IDS.anthropicClaudeOpus48,
  codexDefault: RAW_MODEL_IDS.openAiGpt55,
  codexCliDefault: RAW_MODEL_IDS.openAiGpt55,
  claudeWorkerDefault: RAW_MODEL_IDS.anthropicClaudeSonnet5,
  claudeQaDefault: RAW_MODEL_IDS.anthropicClaudeSonnet5,
  claudeReviewDefault: RAW_MODEL_IDS.anthropicClaudeSonnet5,
  claudeHaikuQaDefault: RAW_MODEL_IDS.anthropicClaudeHaiku45Dated,
  fableDefault: RAW_MODEL_IDS.anthropicClaudeFable5,
  opencodeDefault: RAW_MODEL_IDS.opencodeGpt5Nano,
  mobileOpenAiDefault: RAW_MODEL_IDS.openAiGpt55,
  mobileCliDefault: `cli:codex:${RAW_MODEL_IDS.openAiGpt55}`,
  mobileGeminiDefault: RAW_MODEL_IDS.gemini25Flash,
  raw: RAW_MODEL_IDS,
} as const;

export type ModelId = typeof RAW_MODEL_IDS[keyof typeof RAW_MODEL_IDS];
