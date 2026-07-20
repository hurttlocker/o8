import { describe, expect, it } from 'vitest';

import { resolveDefaultDispatchRuntime } from './dispatch-runtime-default';

describe('resolveDefaultDispatchRuntime', () => {
  it('honors an explicit user runtime', () => {
    expect(resolveDefaultDispatchRuntime({
      explicitRuntime: 'codex',
      orchestratorBackend: 'codex',
    })).toBe('codex');
  });

  it('keeps Codex as the fallback when the operator has not chosen a worker', () => {
    expect(resolveDefaultDispatchRuntime({
      orchestratorBackend: 'codex',
    })).toBe('codex');
  });

  it('does not infer a worker choice from the orchestrator backend', () => {
    expect(resolveDefaultDispatchRuntime({
      orchestratorBackend: 'claude',
    })).toBe('codex');
  });

  it('falls non-frontier orchestrators back to Codex workers', () => {
    expect(resolveDefaultDispatchRuntime({
      orchestratorBackend: 'openclaw',
    })).toBe('codex');
  });

  it('keeps untouched auto defaults on Codex when the orchestrator flips', () => {
    expect(resolveDefaultDispatchRuntime({
      orchestratorBackend: 'auto',
      inAppOrchestratorEnabled: false,
    })).toBe('codex');
    expect(resolveDefaultDispatchRuntime({
      orchestratorBackend: 'auto',
      inAppOrchestratorEnabled: true,
    })).toBe('codex');
  });
});
