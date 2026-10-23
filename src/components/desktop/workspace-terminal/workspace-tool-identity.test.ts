import { describe, expect, it } from 'vitest';
import { upsertWorkspaceToolCall } from './utils';

describe('streamed tool identity', () => {
  it('keeps concurrent calls to the same tool and updates only the matching id', () => {
    const first = { id: 'a', name: 'Bash', status: 'running' as const };
    const second = { id: 'b', name: 'Bash', status: 'running' as const };
    const pending = upsertWorkspaceToolCall([first], second);
    expect(pending).toHaveLength(2);
    expect(upsertWorkspaceToolCall(pending, { ...first, status: 'error', result: 'denied' })).toEqual([{ ...first, status: 'error', result: 'denied' }, second]);
  });
  it('does not replace a completed legacy call with the next call to the same tool', () => {
    expect(upsertWorkspaceToolCall([{ name: 'Bash', status: 'done' }], { name: 'Bash', status: 'running' })).toHaveLength(2);
  });
});
