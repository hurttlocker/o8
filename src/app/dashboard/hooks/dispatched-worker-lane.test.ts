import { describe, expect, it } from 'vitest';

import { dispatchedWorkerRuntime } from './dispatched-worker-lane';

describe('dispatched worker runtime identity', () => {
  it.each(['pi', 'prime-agent', 'qwen', 'goose', 'kimi', 'openhands'])(
    'preserves the registered %s runtime for outside-worker placement',
    (runtime) => {
      expect(dispatchedWorkerRuntime(runtime)).toBe(runtime);
    },
  );

  it('falls back only for an unknown runtime value', () => {
    expect(dispatchedWorkerRuntime('unknown-runtime')).toBe('codex');
    expect(dispatchedWorkerRuntime(null)).toBe('codex');
  });
});
