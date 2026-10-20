import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const prewarmHaikuMock = vi.hoisted(() => vi.fn(async () => {}));
const prewarmSonnetMock = vi.hoisted(() => vi.fn(async () => {}));
const sendToCodexMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('@/lib/cortex/qa/llm/haiku-adapter', () => ({ prewarmHaiku: prewarmHaikuMock }));
vi.mock('@/lib/cortex/qa/llm/sonnet-adapter', () => ({ prewarmSonnetCli: prewarmSonnetMock }));
vi.mock('@/lib/lane/codex-orchestrator-session', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/lane/codex-orchestrator-session')>(),
  ensureCodexOrchestratorSession: () => ({ sessionName: 'codex-scope', status: 'ready' }),
  sendToCodexOrchestrator: sendToCodexMock,
}));

const { codexBackend } = await import('./codex');
const { withOrchestrationMode } = await import('./registry');

describe('Codex backend prompt scope (#2898)', () => {
  afterEach(() => {
    sendToCodexMock.mockClear(); prewarmHaikuMock.mockClear(); prewarmSonnetMock.mockClear();
    vi.unstubAllEnvs();
  });

  it('does not prewarm auxiliary models or expand ambient repo context for a bounded stage', async () => {
    const options = { boundedRefinement: true, permissionMode: 'plan', toolProfile: 'propose' } as const;
    await codexBackend.sendTurn('/tmp/example-repo', 'exact supplied stage prompt', () => {}, options);
    expect(prewarmHaikuMock).not.toHaveBeenCalled(); expect(prewarmSonnetMock).not.toHaveBeenCalled();
    expect((sendToCodexMock.mock.calls[0] as unknown[] | undefined)?.[1]).toBe('exact supplied stage prompt');
    expect((sendToCodexMock.mock.calls[0] as unknown[] | undefined)?.[3]).toBe(options);
    expect(codexBackend.boundedRefinement).toEqual({ version: 1, singleAttempt: true, noAuxiliaryModelCalls: true });
  });

  it('sends a single-mode turn a prompt without dispatch doctrine or MCP tools', async () => {
    vi.stubEnv('O8_DATA_DIR', mkdtempSync(join(tmpdir(), 'o8-codex-scope-')));
    const backend = withOrchestrationMode(codexBackend);

    await backend.sendTurn('/tmp/example-repo', 'work directly', () => {}, { orchestrationMode: 'single' });
    await backend.sendTurn('/tmp/example-repo', 'fan this out', () => {}, { orchestrationMode: 'fleet' });

    const [single, fleet] = sendToCodexMock.mock.calls.map((call) => (call as unknown[])[1] as string);
    expect(single).toContain('dispatch disabled');
    expect(single).not.toMatch(/cortex_[a-z_]+|create_mission|## ORCHESTRATOR PROTOCOL/);
    expect(fleet).toContain('cortex_launch_agent');
    expect(fleet).toContain('## ORCHESTRATOR PROTOCOL');
    expect(fleet).toContain('dispatch_mission({missionId:');
    expect(fleet).toContain('Do not launch a new worker to dispatch an existing mission');
  });
});
