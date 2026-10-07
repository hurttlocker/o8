import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BuiltInAgentRegistration } from './built-in-agent';
import { createBuiltInAgentRuntime } from './built-in-agent';
import { applyBuiltInAgentRuntime, readBuiltInAgentRuntime } from './built-in-agent-server';
import type { Plan } from '@/lib/entitlement/types';

const state = vi.hoisted(() => ({
  registration: null as BuiltInAgentRegistration | null,
  listed: true, launch: true, backend: 'codex', plan: 'free' as Plan,
}));
vi.mock('./built-in-agent', async (original) => ({
  ...await original<typeof import('./built-in-agent')>(),
  get BUILT_IN_AGENT_REGISTRATION() { return state.registration; },
}));
vi.mock('@/lib/entitlement/store', () => ({ getEntitlementSync: () => ({ plan: state.plan }) }));
vi.mock('@/lib/runtimes', () => ({ getRuntime: () => ({ capabilities: { launch: state.launch } }) }));
vi.mock('@/lib/lane/orchestrator-backends/registry', () => ({ getOrchestratorBackend: () => ({ id: state.backend }) }));
vi.mock('@/lib/orchestrator/runtime-capabilities', async (original) => ({
  ...await original<typeof import('@/lib/orchestrator/runtime-capabilities')>(),
  listDispatchableRuntimes: () => state.listed ? ['codex'] : [],
}));

beforeEach(() => {
  state.registration = null; state.listed = true; state.launch = true; state.backend = 'codex'; state.plan = 'free';
});

describe('bundled-agent registry gate', () => {
  it('defaults off and refuses the external Pi adapter even when configured', async () => {
    expect(await readBuiltInAgentRuntime()).toBeNull();
    state.registration = { id: 'pi', backend: 'o8' };
    expect(await readBuiltInAgentRuntime()).toBeNull();
  });

  it('requires both registered roles and a launch-capable worker', async () => {
    state.registration = { id: 'codex', backend: 'codex' };
    state.listed = false;
    expect(await readBuiltInAgentRuntime()).toBeNull();
    state.listed = true; state.launch = false;
    expect(await readBuiltInAgentRuntime()).toBeNull();
    state.launch = true; state.backend = 'claude';
    expect(await readBuiltInAgentRuntime()).toBeNull();
    state.backend = 'codex';
    expect(await readBuiltInAgentRuntime()).toMatchObject({ available: true, label: 'Built-in agent (Pi)' });
  });

  it('never inserts a selectable agent missing from the discovered inventory', () => {
    const builtIn = createBuiltInAgentRuntime({ id: 'codex', backend: 'codex' }, 'free', 'darwin');
    expect(applyBuiltInAgentRuntime([], builtIn)).toEqual([]);
  });

  it('shows free and paid copy from the effective entitlement', async () => {
    state.registration = { id: 'codex', backend: 'codex' };
    expect((await readBuiltInAgentRuntime())?.builtIn?.planDetail).toContain('free daily');
    for (const plan of ['pro', 'team', 'founder'] as const) {
      state.plan = plan;
      expect((await readBuiltInAgentRuntime())?.builtIn?.planDetail).toBe('Uses the included managed model.');
    }
  });

  it('is ready without detection on supported platforms and visibly unavailable on Windows', () => {
    const registration = { id: 'codex', backend: 'codex' } as const;
    for (const platform of ['darwin', 'linux']) {
      expect(createBuiltInAgentRuntime(registration, 'free', platform)).toMatchObject({ available: true, unavailableReason: null });
    }
    const windows = createBuiltInAgentRuntime(registration, 'free', 'win32');
    expect(windows.available).toBe(false);
    expect(windows.detail).toContain('Windows');
    expect(windows.unavailableReason).toBe('unsupported_platform');
  });
});
