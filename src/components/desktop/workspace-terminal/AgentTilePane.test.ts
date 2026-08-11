import { describe, expect, it } from 'vitest';
import {
  canSteerAgentState,
  classifyAgentTileStatus,
  normalizeAgentTileTranscript,
  resolveAgentTileStatus,
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

  it('prepends the operator task when an owned runtime history starts with agent output', () => {
    const entries = normalizeAgentTileTranscript([{
      id: 'assistant-1',
      role: 'assistant',
      text: 'I will inspect the repository now.',
    }], 'Verify live worker chat', {
      id: 'pkt-live-worker',
      text: 'Read README.md and report its first heading.',
    });

    expect(entries.map((entry) => [entry.role, entry.text])).toEqual([
      ['user', 'Read README.md and report its first heading.'],
      ['assistant', 'I will inspect the repository now.'],
    ]);
  });

  it('does not duplicate a task already present as the first user turn', () => {
    const entries = normalizeAgentTileTranscript([{
      id: 'prompt',
      role: 'user',
      text: 'Read README.md.',
    }], 'README check', {
      id: 'pkt-readme',
      text: 'Read README.md.',
    });

    expect(entries).toHaveLength(1);
  });
});

describe('classifyAgentTileStatus', () => {
  it('shows completed worker output as ready for review', () => {
    expect(classifyAgentTileStatus('awaiting_review')).toBe('review');
  });

  it('keeps a genuine failed transcript red', () => {
    expect(classifyAgentTileStatus('failed')).toBe('error');
  });

  it('shows an idle runtime with a huddle-blocked packet as waiting', () => {
    expect(resolveAgentTileStatus('idle', 'blocked', 'huddle_ready')).toBe('waiting');
  });

  it('keeps a runtime exit red even when the inventory has already gone idle', () => {
    expect(resolveAgentTileStatus('idle', 'blocked', 'runtime_process_exit')).toBe('error');
  });
});

describe('canSteerAgentState', () => {
  it('keeps the composer available for a huddle waiting on direction', () => {
    expect(canSteerAgentState(
      { status: 'idle' },
      { status: 'blocked', blockedReason: 'huddle_ready' },
    )).toBe(true);
  });

  it('does not present a steer composer for a failed worker', () => {
    expect(canSteerAgentState(
      { status: 'idle' },
      { status: 'failed', blockedReason: 'runtime_process_exit' },
    )).toBe(false);
  });
});
