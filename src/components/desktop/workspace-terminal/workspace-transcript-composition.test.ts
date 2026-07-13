import { describe, expect, it } from 'vitest';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { composeWorkspaceChatTranscript } from './WorkspaceTranscript';

describe('WorkspaceChatPane transcript composition', () => {
  it('preserves errored tool calls in the shared rendered model', () => {
    const entries: MobileTranscriptEntry[] = [
      {
        id: 'packet-prompt',
        role: 'user',
        text: 'Implement the packet transcript consolidation.',
      },
      {
        id: 'worker-turn',
        role: 'assistant',
        text: 'The renderer is consolidated.',
        toolCalls: [
          { name: 'read_file', status: 'done', args: { path: 'src/worker.ts' } },
          { name: 'exec_command', status: 'error', args: { command: 'npm test' }, result: 'failed' },
        ],
      },
    ];

    const rendered = composeWorkspaceChatTranscript(entries, {
      enabled: true,
      title: 'Renderer consolidation',
      runtime: 'codex',
    });

    expect(rendered[0]?.kind).toBe('packet-header');
    const assistant = rendered[1];
    expect(assistant?.kind).toBe('message');
    if (assistant?.kind !== 'message') throw new Error('Expected assistant render item.');
    expect(assistant.entry).toBe(entries[1]);
    expect(assistant.entry.toolCalls?.map((tool) => tool.status)).toEqual(['done', 'error']);
  });
});
