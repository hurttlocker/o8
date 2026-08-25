import { describe, expect, it } from 'vitest';
import { MODEL_IDS } from '@/lib/models';
import { ORCHESTRATOR_MODEL_OPTIONS } from './settings/dispatch-shared';
import { CLAUDE_CLI_MODELS } from './workspace-terminal/constants';

/**
 * Three surfaces each keep a hand-written Claude model list. Until they are
 * generated from the registry, a new flagship has to be copied into all three
 * — and Opus 5 reached the composer and Settings but not the workspace CLI
 * picker, so a model already in the registry could not be selected (#1808).
 */
const CURRENT_CLAUDE_FLAGSHIPS = [
  MODEL_IDS.raw.anthropicClaudeOpus5,
  MODEL_IDS.raw.anthropicClaudeSonnet5,
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
