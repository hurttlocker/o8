import { describe, expect, it, vi } from 'vitest';

import { executeOrchestratorSlashCommand } from './index';
import type { SlashCommandContext } from './types';

function context(openPromptLibrary: () => void): SlashCommandContext {
  return {
    repoPath: null,
    transcript: [],
    missionState: {
      version: 2,
      prompt: '',
      summary: '',
      packets: [],
      updatedAt: new Date().toISOString(),
    },
    runningTotal: 0,
    currentModel: 'test-model',
    setCurrentModel: () => {},
    appendEntries: () => {},
    replaceTranscript: () => {},
    compactNow: async () => null,
    resetRemoteSession: async () => true,
    queuePrelude: () => {},
    searchArchive: async () => [],
    fetchTelemetry: async () => ({ totalTokens: null, estimatedCostUsd: null, model: null }),
    clearThread: async () => {},
    openPromptLibrary,
  };
}

describe('/prompts', () => {
  it('opens the saved-prompt picker without sending a model turn', async () => {
    const openPromptLibrary = vi.fn();
    const result = await executeOrchestratorSlashCommand('/prompts', context(openPromptLibrary));
    expect(result).toEqual({ handled: true });
    expect(openPromptLibrary).toHaveBeenCalledOnce();
  });
});
