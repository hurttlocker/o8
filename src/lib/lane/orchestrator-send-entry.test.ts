import { describe, expect, it, vi } from 'vitest';
import { homedir } from 'node:os';
import { assertOrchestratorRepoPath } from './repo-preflight';
import { resolveOrchestratorMessageRepoPath } from '../orchestrator/repo-path';
import {
  orchestratorModeAllowsBackendFallback,
  resolveOrchestratorExecutionBackendId,
  sendOrchestratorBackendTurn,
} from './orchestrator-send-entry';
import { withOrchestrationMode } from './orchestrator-backends/registry';
import type { OrchestratorBackend, OrchestratorBackendId } from './orchestrator-backends/types';

function fakeBackend(id: OrchestratorBackendId, sendTurn: OrchestratorBackend['sendTurn']): OrchestratorBackend {
  return {
    id,
    label: id,
    peekSession: () => null,
    ensureSession: () => ({ sessionName: `${id}-session`, status: 'ready' }),
    sendTurn,
  };
}

describe('orchestrator-send backend entry', () => {
  it('resolves the home sentinel and reaches backend preflight with the real path', async () => {
    const sendTurn = vi.fn<OrchestratorBackend['sendTurn']>(async (repoPath) => {
      assertOrchestratorRepoPath(repoPath);
    });
    const backend = fakeBackend('claude', sendTurn);
    const repoPath = resolveOrchestratorMessageRepoPath({
      type: 'orchestrator-send',
      repoPath: '~',
    });

    expect(repoPath).toBe(homedir());
    await sendOrchestratorBackendTurn(backend, repoPath!, 'hello', () => {}, {}, 'fleet');
    expect(sendTurn).toHaveBeenCalledWith(homedir(), 'hello', expect.any(Function), expect.any(Object));
  });

  it('keeps Solo on the selected orchestrator backend', () => {
    expect(resolveOrchestratorExecutionBackendId('openclaw', 'single')).toBe('openclaw');
    expect(resolveOrchestratorExecutionBackendId('claude', 'single')).toBe('claude');
    expect(resolveOrchestratorExecutionBackendId('fable', 'single')).toBe('fable');
    expect(resolveOrchestratorExecutionBackendId('o8', 'single')).toBe('o8');
    expect(resolveOrchestratorExecutionBackendId('collide', 'single')).toBe('collide');
    expect(resolveOrchestratorExecutionBackendId('openclaw', 'fusion')).toBe('openclaw');
    expect(resolveOrchestratorExecutionBackendId('claude', undefined)).toBe('claude');
    expect(orchestratorModeAllowsBackendFallback('single')).toBe(false);
    expect(orchestratorModeAllowsBackendFallback('fusion')).toBe(true);
    expect(orchestratorModeAllowsBackendFallback(undefined)).toBe(true);
  });

  it('sends Solo through the selected backend with its dispatch surface removed', async () => {
    const claudeSend = vi.fn<OrchestratorBackend['sendTurn']>(async () => {});
    const claude = withOrchestrationMode(fakeBackend('claude', claudeSend));

    await sendOrchestratorBackendTurn(claude, '/repo', 'work directly', () => {}, {}, 'single');

    expect(claudeSend).toHaveBeenCalledOnce();
    expect(claudeSend.mock.calls[0]?.[1]).toContain('selected orchestrator runtime');
    expect(claudeSend.mock.calls[0]?.[3]).toMatchObject({
      orchestrationMode: 'single',
      toolProfile: 'solo',
    });
  });

  it('carries Fusion to the selected fan-out backend', async () => {
    const collideSend = vi.fn<OrchestratorBackend['sendTurn']>(async () => {});
    const collide = withOrchestrationMode(fakeBackend('collide', collideSend));

    await sendOrchestratorBackendTurn(collide, '/repo', 'compare deeply', () => {}, {}, 'fusion');

    expect(collideSend).toHaveBeenCalledOnce();
    expect(collideSend.mock.calls[0]?.[1]).toContain('Fusion mode');
    expect(collideSend.mock.calls[0]?.[3]?.orchestrationMode).toBe('fusion');
  });
});
