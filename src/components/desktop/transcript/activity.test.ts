import { describe, expect, it } from 'vitest';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { stopRunningTools, transcriptRunningTools, transcriptScouts } from './activity';

const sleep = { id: 'call-1', name: 'run_command', args: { command: 'sleep 90' }, status: 'running' as const };

describe('native child evidence', () => {
  it('does not turn an ended parent into child completion and retains failed and stopped calls', () => {
    const entries: MobileTranscriptEntry[] = [{ id: 'a', role: 'assistant', text: '', toolCalls: [
      { id: 'live', name: 'Task', args: { description: 'Inspect' }, status: 'running' },
      { id: 'failed', name: 'Task', status: 'error' },
      { id: 'stopped', name: 'Task', status: 'stopped' },
      { id: 'background', name: 'Task', args: { run_in_background: true }, status: 'done' },
      { id: 'finished', name: 'Task', status: 'done' },
    ] }];
    expect(transcriptScouts(entries, false).map(scout => scout.status)).toEqual(['unknown', 'failed', 'stopped', 'unknown', 'done']);
  });

  it('uses the latest receipt for a repeated tool id and excludes prior-turn children', () => {
    const entries: MobileTranscriptEntry[] = [
      { id: 'old', role: 'assistant', text: '', toolCalls: [{ id: 'old', name: 'Task', status: 'done' }] },
      { id: 'user', role: 'user', text: 'Next task' },
      { id: 'a', role: 'assistant', text: '', toolCalls: [{ id: 'same', name: 'Task', status: 'running' }] },
      { id: 'b', role: 'assistant', text: '', toolCalls: [{ id: 'same', name: 'Task', status: 'done' }] },
    ];
    expect(transcriptScouts(entries, true)).toMatchObject([{ id: 'same', status: 'done' }]);
  });
});

describe('stopRunningTools (#3659)', () => {
  it('marks the latest reply\'s in-flight tools stopped, which ends the running state', () => {
    const entries: MobileTranscriptEntry[] = [
      { id: 'a-old', role: 'assistant', text: '', toolCalls: [{ ...sleep, id: 'call-0', status: 'done' }] },
      { id: 'u-1', role: 'user', text: 'Run the sleep.' },
      { id: 'a-1', role: 'assistant', text: '', timestamp: Date.now(), toolCalls: [
        { id: 'call-read', name: 'read_file', status: 'done' },
        sleep,
        { id: 'call-2', name: 'run_command', status: 'calling' },
      ] },
    ];
    expect(transcriptRunningTools(entries, true, Date.now())).toHaveLength(2);

    const stopped = stopRunningTools(entries);

    expect(stopped.at(-1)!.toolCalls!.map((tool) => tool.status)).toEqual(['done', 'stopped', 'stopped']);
    expect(stopped[0]).toBe(entries[0]);
    expect(transcriptRunningTools(stopped, false, Date.now())).toEqual([]);
  });

  it('returns the same transcript when nothing is in flight', () => {
    const entries: MobileTranscriptEntry[] = [{ id: 'a-1', role: 'assistant', text: 'Done.', toolCalls: [{ ...sleep, status: 'done' }] }];
    expect(stopRunningTools(entries)).toBe(entries);
  });
});
