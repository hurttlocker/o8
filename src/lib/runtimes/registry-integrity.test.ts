import { describe, expect, it } from 'vitest';

import {
  ORCHESTRATOR_RUNTIME_IDS,
  ORCHESTRATOR_RUNTIMES,
  isOrchestratorRuntime,
  listDispatchableRuntimes,
} from '@/lib/orchestrator/runtime-capabilities';
import {
  getAllRuntimes,
  getCostParser,
  getRuntime,
} from '@/lib/runtimes';

const REQUIRED_ADAPTER_METHODS = [
  'discoverSessions',
  'readTranscript',
  'launch',
  'resume',
  'interrupt',
  'getChangedFiles',
] as const;

describe('dispatchable runtime registry integrity', () => {
  it('keeps every advertised runtime fully registered and dispatchable consistently', () => {
    const advertised = listDispatchableRuntimes();

    expect(advertised).toHaveLength(12);
    expect(new Set(advertised).size).toBe(advertised.length);

    for (const runtimeId of advertised) {
      const capability = ORCHESTRATOR_RUNTIMES[runtimeId];
      const adapter = getRuntime(runtimeId);

      expect(capability.label.trim(), `${runtimeId} label`).not.toBe('');
      expect(capability.accentColor, `${runtimeId} accent`).toMatch(/^#[0-9a-f]{6}$/i);
      expect(capability.dispatchable, `${runtimeId} dispatchable flag`).toBe(true);
      expect(adapter, `${runtimeId} adapter registration`).toBeDefined();
      expect(adapter?.id, `${runtimeId} adapter id`).toBe(runtimeId);
      expect(adapter?.capabilities.launch, `${runtimeId} launch capability`).toBe(true);

      for (const method of REQUIRED_ADAPTER_METHODS) {
        expect(typeof adapter?.[method], `${runtimeId}.${method}`).toBe('function');
      }

      expect(getCostParser(runtimeId), `${runtimeId} cost parser registration`).toBeDefined();
      if (adapter?.capabilities.costTelemetry) {
        expect(typeof adapter.getTelemetry, `${runtimeId}.getTelemetry`).toBe('function');
      }
    }

    const registeredCanonicalLaunchers = getAllRuntimes()
      .filter((runtime) => isOrchestratorRuntime(runtime.id) && runtime.capabilities.launch)
      .map((runtime) => runtime.id)
      .sort();
    expect(registeredCanonicalLaunchers).toEqual([...advertised].sort());
  });

  it('keeps non-dispatchable canonical entries non-launchable', () => {
    for (const runtimeId of ORCHESTRATOR_RUNTIME_IDS) {
      const capability = ORCHESTRATOR_RUNTIMES[runtimeId];
      const adapter = getRuntime(runtimeId);
      expect(adapter, `${runtimeId} canonical adapter registration`).toBeDefined();
      expect(adapter?.capabilities.launch, `${runtimeId} dispatchability parity`)
        .toBe(capability.dispatchable);
    }
  });
});
