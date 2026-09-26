import { describe, expect, it } from 'vitest';
import { formatModelLabel } from '@/lib/format';
import { MODEL_IDS } from '@/lib/models';
import { BRAIN_CODEX_MODEL_OPTIONS, ORCHESTRATOR_MODEL_OPTIONS } from './settings/dispatch-shared';
import { CLI_RUNTIME_MODELS } from './llm-chat/shared';
import { CLAUDE_CLI_MODELS, CODEX_CLI_MODELS } from './workspace-terminal/constants';

/**
 * Three surfaces each keep a hand-written Claude model list. Until they are
 * generated from the registry, a new flagship has to be copied into all three
 * — and Opus 5 reached the composer and Settings but not the workspace CLI
 * picker, so a model already in the registry could not be selected (#1808).
 */
const CURRENT_CLAUDE_FLAGSHIPS = [
  'claude-opus-5-5',
  'claude-fable-5-1',
  MODEL_IDS.raw.anthropicClaudeOpus5,
  MODEL_IDS.raw.anthropicClaudeSonnet5,
] as const;

const CURRENT_CODEX_FLAGSHIPS = [
  MODEL_IDS.raw.openAiGpt6Astra,
  MODEL_IDS.raw.openAiGpt56Sol,
] as const;

describe('Claude model picker coverage', () => {
  it('offers every current Claude flagship in Settings → Models', () => {
    const ids = ORCHESTRATOR_MODEL_OPTIONS.map((option) => option.value);
    for (const id of CURRENT_CLAUDE_FLAGSHIPS) expect(ids).toContain(id);
  });

  it('offers every current Claude flagship in the workspace CLI picker', () => {
    const ids = CLAUDE_CLI_MODELS.map((option) => option.id);
    for (const id of CURRENT_CLAUDE_FLAGSHIPS) expect(ids).toContain(id);
  });

  it('has a real label for each of them, never the bare id', () => {
    for (const id of CURRENT_CLAUDE_FLAGSHIPS) {
      const settingsOption = ORCHESTRATOR_MODEL_OPTIONS.find((option) => option.value === id);
      const workspaceOption = CLAUDE_CLI_MODELS.find((option) => option.id === id);
      expect(settingsOption?.label.trim()).toBeTruthy();
      expect(settingsOption?.label).not.toBe(id);
      expect(workspaceOption?.label.trim()).toBeTruthy();
      expect(workspaceOption?.label).not.toBe(id);
    }
  });
});

describe('Codex model picker coverage', () => {
  it('offers Astra and Sol in settings and both CLI pickers', () => {
    const settingsIds = BRAIN_CODEX_MODEL_OPTIONS.map((option) => option.value);
    const workspaceIds = CODEX_CLI_MODELS.map((option) => option.id);
    const chatIds = CLI_RUNTIME_MODELS.codex.map((option) => option.id.replace('cli:codex:', ''));

    for (const id of CURRENT_CODEX_FLAGSHIPS) {
      expect(settingsIds).toContain(id);
      expect(workspaceIds).toContain(id);
      expect(chatIds).toContain(id);
    }
  });
});

it('formats current model IDs without dropping their minor versions', () => {
  expect(formatModelLabel('anthropic/claude-opus-5-5')).toBe('Opus 5.5');
  expect(formatModelLabel('claude-fable-5-1')).toBe('Fable 5.1');
  expect(formatModelLabel('gpt-6-sol')).toBe('GPT-6 Sol');
});

it('keeps the unverified subscription model out of curated Codex choices', () => {
  expect(BRAIN_CODEX_MODEL_OPTIONS.map((item) => item.value)).not.toContain('gpt-6-sol');
  expect(CODEX_CLI_MODELS.map((item) => item.id)).not.toContain('gpt-6-sol');
});
