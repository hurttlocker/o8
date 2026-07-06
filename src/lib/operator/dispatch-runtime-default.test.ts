import { describe, expect, it } from 'vitest';

import { resolveDefaultDispatchRuntime } from './dispatch-runtime-default';

describe('resolveDefaultDispatchRuntime', () => {
  it('honors an explicit user runtime', () => {
    expect(resolveDefaultDispatchRuntime({
      explicitRuntime: 'codex',
      orchestratorBackend: 'codex',
    })).toBe('codex');
  });

  it('pairs Codex orchestrators with Claude Code workers', () => {
    expect(resolveDefaultDispatchRuntime({
      orchestratorBackend: 'codex',
    })).toBe('claude-code');
  });

  it('pairs Claude orchestrators with Codex workers', () => {
    expect(resolveDefaultDispatchRuntime({
      orchestratorBackend: 'claude',
    })).toBe('codex');
  });

  it('falls non-frontier orchestrators back to Codex workers', () => {
    expect(resolveDefaultDispatchRuntime({
      orchestratorBackend: 'openclaw',
    })).toBe('codex');
  });

  it('keeps untouched auto defaults live when the orchestrator flips', () => {
    expect(resolveDefaultDispatchRuntime({
      orchestratorBackend: 'auto',
      inAppOrchestratorEnabled: false,
    })).toBe('claude-code');
    expect(resolveDefaultDispatchRuntime({
      orchestratorBackend: 'auto',
      inAppOrchestratorEnabled: true,
    })).toBe('codex');
  });
});
