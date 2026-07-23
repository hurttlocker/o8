import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  pythonSpawn: vi.fn(),
  warmupOpenRouter: vi.fn(),
  ensureEdgeTtsInstalled: vi.fn(),
}));

vi.mock('@/lib/telemetry/crash-capture', () => ({
  installProcessCrashCapture: vi.fn(),
}));
vi.mock('@/lib/telemetry/uploader', () => ({
  startTelemetryUploadLoop: vi.fn(),
}));
vi.mock('@/lib/telemetry/sentry-node', () => ({
  initSentryNode: vi.fn(),
}));
vi.mock('@/lib/mobile/orchestrator-thread-history', () => ({
  repairComposerPreamblePollution: vi.fn(),
  repairFlippedOrchestratorTranscripts: vi.fn(),
}));
vi.mock('@/lib/cortex/qa/llm/openrouter-adapter', () => ({
  warmupOpenRouter: mocks.warmupOpenRouter.mockImplementation(async () => {
    await mocks.fetch('https://openrouter.ai/api/v1/models');
  }),
}));
vi.mock('@/lib/tts/ensure-edge-tts', () => ({
  ensureEdgeTtsInstalled: mocks.ensureEdgeTtsInstalled.mockImplementation(async () => {
    mocks.pythonSpawn('python3', ['-m', 'pip', 'install', 'edge-tts']);
  }),
}));

const priorNextRuntime = process.env.NEXT_RUNTIME;
const priorO8DataDir = process.env.O8_DATA_DIR;
const priorCortexDataDir = process.env.CORTEX_IDE_DATA_DIR;
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-cold-start-instrumentation-'));

beforeAll(() => {
  process.env.NEXT_RUNTIME = 'nodejs';
  process.env.O8_DATA_DIR = dataDir;
  delete process.env.CORTEX_IDE_DATA_DIR;
});

afterAll(() => {
  vi.unstubAllGlobals();
  if (priorNextRuntime === undefined) delete process.env.NEXT_RUNTIME;
  else process.env.NEXT_RUNTIME = priorNextRuntime;
  if (priorO8DataDir === undefined) delete process.env.O8_DATA_DIR;
  else process.env.O8_DATA_DIR = priorO8DataDir;
  if (priorCortexDataDir === undefined) delete process.env.CORTEX_IDE_DATA_DIR;
  else process.env.CORTEX_IDE_DATA_DIR = priorCortexDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('cold-start instrumentation', () => {
  it('performs no outbound warm-up or Python install during server boot', async () => {
    vi.stubGlobal('fetch', mocks.fetch);
    const { register } = await import('@/instrumentation');

    await register();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(mocks.warmupOpenRouter).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.ensureEdgeTtsInstalled).not.toHaveBeenCalled();
    expect(mocks.pythonSpawn).not.toHaveBeenCalled();
  });
});
