import { expect, it, vi } from 'vitest';
import { sendBoundComposerTurn } from './bound-composer-turn';
import { resolveOrchestratorTurnOptions } from './resolve-turn-options';
import type { OrchestratorSendOptions } from './types';
it('preserves a pinned runtime and model across delayed repository persistence and changed defaults', async () => {
  let captured!: OrchestratorSendOptions;
  const refreshedDefaults = vi.fn(async () => ({ backend: 'codex' as const, model: 'different' }));
  let ready!: (value: boolean) => void;
  sendBoundComposerTurn((_text, options) => { captured = options; return null; }, 'hello', {
    backend: 'claude', model: 'chosen', resolveTurnOptions: async () => ({ backend: 'claude', model: 'chosen' }),
  }, { pickedMode: 'multitask', ensureSelectedRepoPersisted: () => new Promise(resolve => { ready = resolve; }),
    restoreDraft: vi.fn(), resolveOptions: refreshedDefaults });
  const resolved = resolveOrchestratorTurnOptions(captured, new AbortController().signal);
  ready(true);
  expect(await resolved).toMatchObject({ backend: 'claude', model: 'chosen' });
  expect(refreshedDefaults).not.toHaveBeenCalled();
});
