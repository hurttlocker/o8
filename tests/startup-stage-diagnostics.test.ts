import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const warning = '[startup] Optional initialization failed; continuing startup.';
const calls: string[] = [];
const importedModules: string[] = [];
let failedImport: string | null = null;
const mocks = {
  installProcessCrashCapture: vi.fn(),
  startTelemetryUploadLoop: vi.fn(),
  initSentryNode: vi.fn(),
  repairFlippedOrchestratorTranscripts: vi.fn(),
  repairComposerPreamblePollution: vi.fn(),
  runUnifiedSearchBackfills: vi.fn(),
  ensureReviewQueueDrainStarted: vi.fn(),
};
const warn = vi.fn();

function failImportIfSelected(module: string): void {
  if (failedImport === module) throw new Error('synthetic import failure');
}

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.stubEnv('NEXT_RUNTIME', 'nodejs');
  vi.stubEnv('O8_PACKAGED_APP', undefined);
  vi.stubEnv('NEXT_PHASE', undefined);
  vi.spyOn(console, 'warn').mockImplementation(warn);
  calls.length = 0;
  importedModules.length = 0;
  failedImport = null;
  for (const [name, mock] of Object.entries(mocks)) {
    mock.mockImplementation(() => { calls.push(name); });
  }

  vi.doMock('@/lib/telemetry/crash-capture', () => {
    failImportIfSelected('@/lib/telemetry/crash-capture');
    importedModules.push('crash-capture');
    return { installProcessCrashCapture: mocks.installProcessCrashCapture };
  });
  vi.doMock('@/lib/telemetry/uploader', () => {
    failImportIfSelected('@/lib/telemetry/uploader');
    importedModules.push('uploader');
    return { startTelemetryUploadLoop: mocks.startTelemetryUploadLoop };
  });
  vi.doMock('@/lib/telemetry/sentry-node', () => {
    failImportIfSelected('@/lib/telemetry/sentry-node');
    importedModules.push('sentry-node');
    return { initSentryNode: mocks.initSentryNode };
  });
  vi.doMock('@/lib/mobile/orchestrator-thread-history', () => {
    failImportIfSelected('@/lib/mobile/orchestrator-thread-history');
    importedModules.push('transcript-repair');
    return {
      repairFlippedOrchestratorTranscripts: mocks.repairFlippedOrchestratorTranscripts,
      repairComposerPreamblePollution: mocks.repairComposerPreamblePollution,
    };
  });
  vi.doMock('@/lib/search/backfill', () => {
    importedModules.push('backfill');
    return { runUnifiedSearchBackfills: mocks.runUnifiedSearchBackfills };
  });
  vi.doMock('@/lib/lane/review-drain-bootstrap', () => {
    importedModules.push('review-drain');
    return { ensureReviewQueueDrainStarted: mocks.ensureReviewQueueDrainStarted };
  });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function registerAndSettle(): Promise<void> {
  const { register } = await import('@/instrumentation');
  await expect(register()).resolves.toBeUndefined();
  await vi.dynamicImportSettled();
}

async function expectDeferredBackfill(): Promise<void> {
  expect(mocks.runUnifiedSearchBackfills).not.toHaveBeenCalled();
  expect(importedModules).not.toContain('backfill');
  await vi.advanceTimersByTimeAsync(1_499);
  expect(mocks.runUnifiedSearchBackfills).not.toHaveBeenCalled();
  expect(importedModules).not.toContain('backfill');
  await vi.advanceTimersByTimeAsync(1);
  await vi.dynamicImportSettled();
  expect(mocks.runUnifiedSearchBackfills).toHaveBeenCalledTimes(1);
}

function expectStageWarning(stage: 'telemetry' | 'transcript-repair'): void {
  expect(warn.mock.calls).toEqual([[warning, { stage }]]);
}

const telemetryImports = [
  '@/lib/telemetry/crash-capture',
  '@/lib/telemetry/uploader',
  '@/lib/telemetry/sentry-node',
] as const;
const telemetryInitializers = [
  'installProcessCrashCapture',
  'startTelemetryUploadLoop',
  'initSentryNode',
] as const;
const repairInitializers = [
  'repairFlippedOrchestratorTranscripts',
  'repairComposerPreamblePollution',
] as const;

describe('startup stage diagnostics through register', () => {
  it('keeps successful startup quiet and preserves initialization order and delayed backfill', async () => {
    await registerAndSettle();

    expect(calls).toEqual([...telemetryInitializers, ...repairInitializers]);
    expect(mocks.installProcessCrashCapture).toHaveBeenCalledWith('next-server');
    expect(mocks.initSentryNode).toHaveBeenCalledWith('server');
    expect(mocks.ensureReviewQueueDrainStarted).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    await expectDeferredBackfill();
    expect(calls).toEqual([...telemetryInitializers, ...repairInitializers, 'runUnifiedSearchBackfills']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('does no optional work or logging in Edge even when packaged', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'edge');
    vi.stubEnv('O8_PACKAGED_APP', '1');

    await registerAndSettle();
    await vi.advanceTimersByTimeAsync(1_500);
    await vi.dynamicImportSettled();

    expect(importedModules).toEqual([]);
    expect(calls).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(telemetryImports)('identifies telemetry import failure at %s and continues later work', async (module) => {
    failedImport = module;

    await registerAndSettle();
    expect(mocks.repairFlippedOrchestratorTranscripts).toHaveBeenCalledTimes(1);
    expect(mocks.repairComposerPreamblePollution).toHaveBeenCalledTimes(1);
    await expectDeferredBackfill();
    expectStageWarning('telemetry');
  });

  it.each(telemetryInitializers)('identifies unexpected telemetry initializer failure at %s', async (initializer) => {
    mocks[initializer].mockImplementation(() => { throw new Error('synthetic initializer failure'); });

    await registerAndSettle();
    expect(mocks.repairFlippedOrchestratorTranscripts).toHaveBeenCalledTimes(1);
    expect(mocks.repairComposerPreamblePollution).toHaveBeenCalledTimes(1);
    await expectDeferredBackfill();
    expectStageWarning('telemetry');
  });

  it('identifies transcript-repair import failure and continues delayed backfill', async () => {
    failedImport = '@/lib/mobile/orchestrator-thread-history';

    await registerAndSettle();
    expect(calls).toEqual([...telemetryInitializers]);
    await expectDeferredBackfill();
    expectStageWarning('transcript-repair');
  });

  it.each(repairInitializers)('identifies unexpected transcript-repair failure at %s', async (initializer) => {
    mocks[initializer].mockImplementation(() => { throw new Error('synthetic repair failure'); });

    await registerAndSettle();
    expect(calls.slice(0, 3)).toEqual([...telemetryInitializers]);
    await expectDeferredBackfill();
    expectStageWarning('transcript-repair');
  });

  it.each([
    ['telemetry', 'installProcessCrashCapture'],
    ['transcript-repair', 'repairFlippedOrchestratorTranscripts'],
  ] as const)('never inspects or logs arbitrary exception content for %s', async (stage, initializer) => {
    const inspect = vi.fn(() => { throw new Error('exception properties must stay unread'); });
    const failure = Object.create(null);
    for (const property of ['message', 'stack', 'body', 'path', 'token', 'toString', 'toJSON', Symbol.toPrimitive]) {
      Object.defineProperty(failure, property, { get: inspect });
    }
    mocks[initializer].mockImplementation(() => { throw failure; });

    await registerAndSettle();
    await expectDeferredBackfill();
    expect(inspect).not.toHaveBeenCalled();
    expectStageWarning(stage);
  });

  it.each([
    ['telemetry', 'installProcessCrashCapture'],
    ['transcript-repair', 'repairFlippedOrchestratorTranscripts'],
  ] as const)('continues startup when the warning sink throws for %s', async (stage, initializer) => {
    mocks[initializer].mockImplementation(() => { throw new Error('synthetic startup failure'); });
    warn.mockImplementation(() => { throw new Error('synthetic warning sink failure'); });

    await registerAndSettle();
    await expectDeferredBackfill();
    expectStageWarning(stage);
  });
});
