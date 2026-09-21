import { describe, expect, it } from 'vitest';
import { parseAntigravityRunLog } from './antigravity-protocol';
import type { OwnedRunRecord } from './shared/owned-session';

const run = { id: 'run-1', mode: 'launch', prompt: 'hello', startedAt: '2026-09-21T00:00:00Z', outcome: 'running' } as OwnedRunRecord;
const line = (event: string, payload: object) => JSON.stringify({ event, ...payload });
describe('owned headless protocol', () => {
  it('combines streamed deltas without duplicating the final answer', () => {
    const raw = [
      line('init', { conversation_id: 'conversation-1' }),
      line('step_update', { step_update: { step_index: 1, step_type: 'agent_response', text_delta: 'hel' } }),
      line('step_update', { step_update: { step_index: 1, step_type: 'agent_response', text_delta: 'lo' } }),
      line('result', { result: { conversation_id: 'conversation-1', status: 'SUCCESS', response: 'hello' } }),
    ].join('\n');
    const parsed = parseAntigravityRunLog(raw, run);
    expect(parsed.threadId).toBe('conversation-1');
    expect(parsed.completedTurn).toBe(true);
    expect(parsed.entries.filter(e => e.kind === 'message').map(e => e.text)).toEqual(['hello']);
  });
  it.each(['ERROR', 'INVALID', 'WAITING', 'RUNNING'])('does not accept %s as completion', (status) => {
    const parsed = parseAntigravityRunLog(line('result', { result: { status, error: 'blocked' } }), run);
    expect(parsed.completedTurn).toBe(false);
    expect(parsed.outcome).toBe('failed');
  });
  it('fails a clean process exit without a successful result', () => {
    const parsed = parseAntigravityRunLog(line('init', { conversation_id: 'conversation-1' }), { ...run, outcome: 'finished', finishedAt: run.startedAt });
    expect(parsed.completedTurn).toBe(false);
    expect(parsed.outcome).toBe('failed');
  });
  it('preserves tool details and explicit interruption', () => {
    const parsed = parseAntigravityRunLog([
      line('step_update', { step_update: { step_index: 2, step_type: 'tool', tool_name: 'view_file', tool_info: { parameters: { path: 'a.ts' }, output: 'contents' } } }),
      line('result', { result: { status: 'INTERRUPTED' } }),
    ].join('\n'), run);
    expect(parsed.outcome).toBe('interrupted');
    expect(parsed.entries.some(e => e.label === 'view_file' && e.text.includes('a.ts'))).toBe(true);
  });
});
