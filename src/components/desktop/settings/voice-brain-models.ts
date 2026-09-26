import { MODEL_IDS } from '@/lib/models';

// Match the planner's accepted pins, not the broader workspace chat catalog.
// voice-brain-models.test.ts checks these against the native adapter registry.
export const VOICE_BRAIN_MODELS: Record<string, { value: string; label: string }[]> = {
  claude: [
    { value: MODEL_IDS.raw.anthropicClaudeOpus48, label: 'Opus 4.8' },
    { value: MODEL_IDS.raw.anthropicClaudeOpus5, label: 'Opus 5' },
    { value: MODEL_IDS.raw.anthropicClaudeSonnet5, label: 'Sonnet 5' },
    { value: MODEL_IDS.raw.anthropicClaudeHaiku45Dated, label: 'Haiku 4.5' },
    { value: MODEL_IDS.raw.anthropicClaudeFable5, label: 'Fable 5' },
  ],
  codex: [
    { value: MODEL_IDS.raw.openAiGpt6Sol, label: 'GPT-6 Sol' },
    { value: MODEL_IDS.raw.openAiGpt56Sol, label: 'GPT-5.6 Sol' },
    { value: MODEL_IDS.raw.openAiGpt56Terra, label: 'GPT-5.6 Terra' },
  ],
};
