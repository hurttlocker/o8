import { expect, it, vi } from 'vitest';
import { trackComposerSubmission } from './track-submission';
import { resolveOrchestratorTurnOptions } from './resolve-turn-options';
it('releases the exact local pending turn on failed repository persistence without dispatch', async () => {
  const terminal = vi.fn(); const dispatch = vi.fn();
  await trackComposerSubmission('user-one', terminal, async mark => {
    if (await resolveOrchestratorTurnOptions({ beforeSend: async () => false }, new AbortController().signal) === null) return;
    mark(); dispatch();
  });
  expect(dispatch).not.toHaveBeenCalled();
  expect(terminal).toHaveBeenCalledWith(expect.objectContaining({ userMessageId: 'user-one', outcome: 'failed' }));
});
it('reports a pre-dispatch exception but does not mislabel uncertain delivery as non-submission', async () => {
  const terminal = vi.fn();
  await trackComposerSubmission('before', terminal, async () => { throw new Error('option resolution'); });
  await trackComposerSubmission('after', terminal, async mark => { mark(); throw new Error('socket unknown'); });
  expect(terminal).toHaveBeenCalledTimes(1);
  expect(terminal.mock.calls[0][0].userMessageId).toBe('before');
});
