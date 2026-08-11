import { describe, expect, it } from 'vitest';
import {
  classifyAgentTileStatus,
  normalizeAgentTileTranscript,
  shouldRefreshAgentTranscript,
} from './AgentTilePane';

describe('shouldRefreshAgentTranscript', () => {
  it('keeps polling while an agent record exists regardless of steering status', () => {
    expect(shouldRefreshAgentTranscript(true, false)).toBe(true);
  });

  it('keeps polling through the lane-only retirement window', () => {
    expect(shouldRefreshAgentTranscript(false, true)).toBe(true);
  });

  it('stops after both live records disappear', () => {
    expect(shouldRefreshAgentTranscript(false, false)).toBe(false);
  });
});

describe('normalizeAgentTileTranscript', () => {
  it('shows the assigned task instead of the injected worker envelope', () => {
    const entries = normalizeAgentTileTranscript([{
      id: 'prompt',
      role: 'user',
      text: [
        '## Project Brief',
        '',
        'Project: Workspace (0 repos)',
        '',
        '## Task',
        'Packet: Verify Codex setup',
        'Summary: Task inline-1: Verify Codex setup',
        '',
        'Add one verification step to README.md.',
        'Branch target: inline/demo',
        'Internal worker rules that should stay hidden.',
      ].join('\n'),
    }]);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.text).toBe('Add one verification step to README.md.');
  });

  it('handles the flat prompt shape returned by owned runtime history', () => {
    const entries = normalizeAgentTileTranscript([{
      id: 'prompt',
      role: 'user',
      text: '## Project Brief Project: Workspace (0 repos) ## Task Packet: Verify Codex setup Summary: Task inline-1: Verify Codex setup Add one verification step to README.md. Branch target: inline/demo Internal worker rules.',
    }], 'Verify Codex setup');

    expect(entries[0]?.text).toBe('Add one verification step to README.md.');
  });
});

describe('classifyAgentTileStatus', () => {
  it('shows completed worker output as ready for review', () => {
    expect(classifyAgentTileStatus('awaiting_review')).toBe('review');
  });

  it('keeps a genuine failed transcript red', () => {
    expect(classifyAgentTileStatus('failed')).toBe('error');
  });
});
