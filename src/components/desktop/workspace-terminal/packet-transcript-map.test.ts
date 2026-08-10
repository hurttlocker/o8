import { describe, expect, it } from 'vitest';
import type { TranscriptEvent } from '@/lib/orchestrator/transcript-normalizer';
import { mapPacketTranscriptEntries, shouldPollPacketTranscript } from './use-packet-transcript-poll';

function toolCallEvent(args: string, tool = 'exec'): TranscriptEvent {
  return { seq: 1, ts: '2026-07-07T12:00:00.000Z', type: 'tool_call', tool, args, summary: args.slice(0, 40) };
}

function assistantEvent(): TranscriptEvent {
  return { seq: 2, ts: '2026-07-07T12:00:01.000Z', type: 'assistant', text: 'done' };
}

function firstToolCall(events: TranscriptEvent[]) {
  const entries = mapPacketTranscriptEntries(events);
  return entries[0]?.toolCalls?.[0];
}

describe('mapPacketTranscriptEntries tool args recovery', () => {
  it('recovers the human command from Codex exec array args', () => {
    const tool = firstToolCall([
      toolCallEvent(JSON.stringify({ command: ['bash', '-lc', 'npm run typecheck'] })),
      assistantEvent(),
    ]);
    expect(tool?.args?.command).toBe('npm run typecheck');
  });

  it('passes structured object args through', () => {
    const tool = firstToolCall([
      toolCallEvent(JSON.stringify({ file_path: '/repo/src/a.ts' }), 'read_file'),
      assistantEvent(),
    ]);
    expect(tool?.args?.file_path).toBe('/repo/src/a.ts');
  });

  it('wraps raw string args as a command', () => {
    const tool = firstToolCall([toolCallEvent('git status --short'), assistantEvent()]);
    expect(tool?.args?.command).toBe('git status --short');
  });

  it('drops clipped (unparseable) JSON args instead of rendering garbage', () => {
    const clipped = JSON.stringify({ command: ['bash', '-lc', 'x'.repeat(700)] }).slice(0, 600);
    const tool = firstToolCall([toolCallEvent(clipped), assistantEvent()]);
    expect(tool?.args).toBeUndefined();
    expect(tool?.preview).toBeTruthy();
  });
});

describe('shouldPollPacketTranscript', () => {
  it('keeps polling when owned-session history only contains the launch prompt', () => {
    expect(shouldPollPacketTranscript([
      { id: 'prompt', role: 'user', text: 'Inspect the repository.' },
    ])).toBe(true);
  });

  it('stops the fallback poll after a substantive assistant entry arrives', () => {
    expect(shouldPollPacketTranscript([
      { id: 'answer', role: 'assistant', text: 'The repository is clean.' },
    ])).toBe(false);
  });
});
