import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-onboarding-runtime-picker-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const fullInventory = [
  {
    id: 'codex',
    label: 'Codex',
    available: true,
    unavailableReason: null,
    detail: 'Codex is installed and signed in.',
    fix: '',
  },
  {
    id: 'claude-code',
    label: 'Claude Code',
    available: true,
    unavailableReason: null,
    detail: 'Claude Code is installed and signed in.',
    fix: '',
  },
  {
    id: 'gemini',
    label: 'Gemini',
    available: false,
    unavailableReason: 'needs_auth',
    detail: 'Gemini CLI is installed but not signed in.',
    fix: 'Run `gemini` once to sign in.',
  },
] as Array<{
  id: 'codex' | 'claude-code' | 'gemini';
  label: string;
  available: boolean;
  unavailableReason: 'needs_auth' | 'not_installed' | null;
  detail: string;
  fix: string;
}>;
let inventory = fullInventory.map((runtime) => ({ ...runtime }));

vi.mock('@/lib/runtimes/shared/auth-detect', () => ({
  getRuntimeAuthSnapshot: vi.fn(async () => ({
    statuses: {},
    suggestedSubscriptionProfile: { profile: null, detail: null },
  })),
  getDispatchableRuntimeAvailability: vi.fn(async () => inventory),
}));

const route = await import('@/app/api/panel/operator-defaults/route');
const {
  loadOnboardingRuntimeSelection,
  persistOnboardingRuntimeSelection,
  toggleOnboardingWorkerRuntime,
} = await import('@/components/desktop/onboarding/onboarding-runtime-selection');

async function routeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input.toString();
  if (init?.method === 'POST') {
    return route.POST(new Request(`http://127.0.0.1${url}`, init));
  }
  return route.GET();
}

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('onboarding runtime picker — real operator-defaults path', () => {
  it('reads discovery, blocks unavailable choices, and persists the orchestrator and worker pool', async () => {
    inventory = fullInventory.map((runtime) => runtime.id === 'codex'
      ? {
          ...runtime,
          available: false,
          unavailableReason: 'not_installed' as const,
          detail: 'Codex CLI is not installed.',
          fix: 'Install Codex, then run `codex login`.',
        }
      : { ...runtime });
    const singleRuntime = await loadOnboardingRuntimeSelection(routeFetch);
    expect(singleRuntime.orchestratorRuntime).toBe('claude-code');
    expect(singleRuntime.workerRuntimes).toEqual(['claude-code']);

    inventory = fullInventory.map((runtime) => ({ ...runtime }));
    const loaded = await loadOnboardingRuntimeSelection(routeFetch);
    expect(loaded.inventory).toEqual(inventory);
    expect(loaded.orchestratorRuntime).toBe('codex');
    expect(loaded.workerRuntimes).toEqual(['codex']);

    const afterUnavailableToggle = toggleOnboardingWorkerRuntime(
      loaded.workerRuntimes,
      'gemini',
      loaded.inventory,
    );
    expect(afterUnavailableToggle).toEqual(['codex']);

    await persistOnboardingRuntimeSelection({
      orchestratorRuntime: 'claude-code',
      workerRuntimes: ['claude-code', 'codex'],
    }, routeFetch);

    const response = await route.GET();
    const persisted = await response.json();
    expect(persisted.values.orchestratorBackend).toBe('claude');
    expect(persisted.values.defaultDispatchRuntime).toBe('claude-code');
    expect(persisted.values.workerRuntimes).toEqual(['claude-code', 'codex']);
    expect(persisted.sources.workerRuntimes).toBe('file');

    inventory = [
      {
        id: 'gemini',
        label: 'Gemini',
        available: true,
        unavailableReason: null,
        detail: 'Gemini CLI is installed and signed in.',
        fix: '',
      },
      ...inventory.filter((runtime) => runtime.id !== 'gemini'),
    ];

    const afterLaterInstall = await loadOnboardingRuntimeSelection(routeFetch);
    expect(afterLaterInstall.orchestratorRuntime).toBe('claude-code');
    expect(afterLaterInstall.workerRuntimes).toEqual(['claude-code', 'codex']);

    const afterLaterInstallResponse = await route.GET();
    await expect(afterLaterInstallResponse.json()).resolves.toMatchObject({
      values: {
        orchestratorBackend: 'claude',
        defaultDispatchRuntime: 'claude-code',
        workerRuntimes: ['claude-code', 'codex'],
      },
    });
  });

  it('returns an honest, skippable empty selection when no agent CLI is installed', async () => {
    inventory = [
      {
        id: 'codex',
        label: 'Codex',
        available: false,
        unavailableReason: 'not_installed',
        detail: 'Codex CLI is not installed.',
        fix: 'Install Codex, then run `codex login`.',
      },
      {
        id: 'claude-code',
        label: 'Claude Code',
        available: false,
        unavailableReason: 'not_installed',
        detail: 'Claude Code CLI is not installed.',
        fix: 'Install Claude Code, then run `claude` once to sign in.',
      },
    ];

    const loaded = await loadOnboardingRuntimeSelection(routeFetch);
    expect(loaded.inventory.every((runtime) => !runtime.available)).toBe(true);
    expect(loaded.orchestratorRuntime).toBe('codex');
    expect(loaded.workerRuntimes).toEqual([]);
    expect(toggleOnboardingWorkerRuntime([], 'codex', loaded.inventory)).toEqual([]);
  });
});
