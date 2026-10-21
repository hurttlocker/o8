import { describe, expect, it, vi } from 'vitest';
import { executeOrchestratorSlashCommand, getOrchestratorSlashCommandSuggestions } from './index';
import type { SlashCommandContext } from './types';

function context(): SlashCommandContext {
  return { repoPath: '/workspace', transcript: [], missionState: { version: 2, prompt: '', summary: '', packets: [], updatedAt: '' },
    runningTotal: 0, currentModel: 'selected-model', setCurrentModel: vi.fn(), appendEntries: vi.fn(), replaceTranscript: vi.fn(),
    compactNow: vi.fn(), resetRemoteSession: vi.fn(), queuePrelude: vi.fn(), searchArchive: vi.fn(), fetchTelemetry: vi.fn(),
    clearThread: vi.fn(), startOrchestration: vi.fn() };
}

describe('explicit visualization intent through the composer command entry point', () => {
  it.each(['/visualization', '/visualize'])('routes %s to the active conversation with preview and publish instructions', async prefix => {
    const selected = context();
    const raw = `${prefix} show the request flow`;
    expect(await executeOrchestratorSlashCommand(raw, selected)).toEqual({ handled: true });
    expect(selected.startOrchestration).toHaveBeenCalledWith(expect.objectContaining({ displayMessage: raw, goal: 'show the request flow',
      prompt: expect.stringContaining('o8_html_preview') }));
    const request = vi.mocked(selected.startOrchestration!).mock.calls[0][0];
    expect(request.prompt).toContain('o8_html_render');
    expect(request.prompt).toContain('User request:\nshow the request flow');
    expect(request).not.toHaveProperty('model');
    expect(selected.setCurrentModel).not.toHaveBeenCalled();
    expect(selected.clearThread).not.toHaveBeenCalled();
    expect(selected.appendEntries).not.toHaveBeenCalled();
  });

  it('shows one discoverable command for both spellings and asks for a subject without a model turn', async () => {
    expect(getOrchestratorSlashCommandSuggestions('/visual')).toHaveLength(1);
    const selected = context();
    await executeOrchestratorSlashCommand('/visualization', selected);
    expect(selected.startOrchestration).not.toHaveBeenCalled();
    expect(selected.appendEntries).toHaveBeenCalledWith([expect.objectContaining({ text: 'What would you like to visualize?' })]);
  });
});
