import { describe, expect, it, vi } from 'vitest';
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
  it('exposes Single\'s Codex fallback before session metadata is created', () => {
    expect(resolveOrchestratorExecutionBackendId('openclaw', 'single')).toBe('codex');
    expect(resolveOrchestratorExecutionBackendId('collide', 'single')).toBe('codex');
    expect(resolveOrchestratorExecutionBackendId('openclaw', 'fusion')).toBe('openclaw');
    expect(resolveOrchestratorExecutionBackendId('claude', undefined)).toBe('claude');
    expect(orchestratorModeAllowsBackendFallback('single')).toBe(false);
    expect(orchestratorModeAllowsBackendFallback('fusion')).toBe(true);
    expect(orchestratorModeAllowsBackendFallback(undefined)).toBe(true);
  });

  it('routes Single around Collide and into hardened Codex before fan-out', async () => {
    const codexSend = vi.fn<OrchestratorBackend['sendTurn']>(async () => {});
    const collideSend = vi.fn<OrchestratorBackend['sendTurn']>(async () => {});
    const codex = withOrchestrationMode(fakeBackend('codex', codexSend), () => codex);
    const resolve = () => codex;
    const collide = withOrchestrationMode(fakeBackend('collide', collideSend), resolve);

    await sendOrchestratorBackendTurn(collide, '/repo', 'work directly', () => {}, {}, 'single');

    expect(collideSend).not.toHaveBeenCalled();
    expect(codexSend).toHaveBeenCalledOnce();
    expect(codexSend.mock.calls[0]?.[1]).toContain('hardened Codex direct mode');
    expect(codexSend.mock.calls[0]?.[3]?.orchestrationMode).toBe('single');
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
