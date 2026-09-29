import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeComposerWireMessage, modelFacingComposerMessage, type ComposerWireMode } from '../orchestrator/composer-wire';
import { withOrchestratorTurnReceiptContext } from '../orchestrator/turn-receipt-context';
import { assertOrchestratorRepoPath } from './repo-preflight';
import { resolveOrchestratorMessageRepoPath } from '../orchestrator/repo-path';
import {
  orchestratorModeAllowsBackendFallback,
  resolveOrchestratorExecutionBackendId,
  sendOrchestratorBackendTurn,
} from './orchestrator-send-entry';
import { resolveOrchestratorExecutionMode } from './orchestrator-backends/orchestration-mode';
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

/**
 * The model-facing steps ws-server's orchestrator-send handler applies, in its
 * order: composer text -> mode-scoped operator message -> turn receipt -> the
 * backend send seam (which adds the registry's mode banner).
 */
async function sendComposerTurn(pickedMode: ComposerWireMode, rawOrchestrationMode: string) {
  const sendTurn = vi.fn<OrchestratorBackend['sendTurn']>(async () => {});
  const backend = withOrchestrationMode(fakeBackend('claude', sendTurn));
  const { wireMessage } = composeComposerWireMessage('Fix the footer', pickedMode);
  const executionMode = resolveOrchestratorExecutionMode(rawOrchestrationMode);
  const turnMessage = withOrchestratorTurnReceiptContext({
    message: modelFacingComposerMessage(wireMessage, executionMode),
    threadId: 'thoughts-banner',
    turnId: 'assistant-banner',
    orchestrationMode: executionMode,
  });
  await sendOrchestratorBackendTurn(backend, '/repo', turnMessage, () => {}, {}, rawOrchestrationMode);
  expect(sendTurn).toHaveBeenCalledOnce();
  return sendTurn.mock.calls[0]![1];
}

const MODE_BANNER = /^\[(?:Mode: [^\]]+|Single agent mode[^\]]*|Fusion mode[^\]]*)\]/gm;

describe('orchestrator-send backend entry', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

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

  it('sends a Solo turn with one mode banner and no create_mission receipt (#2899)', async () => {
    vi.stubEnv('O8_DATA_DIR', mkdtempSync(join(tmpdir(), 'o8-solo-banner-')));
    // Picked Solo, and a forced-single turn whose picked mode carries a dispatch directive.
    for (const pickedMode of ['solo', 'multitask'] as const) {
      const message = await sendComposerTurn(pickedMode, 'single');
      expect(message.match(MODE_BANNER), pickedMode).toEqual(['[Single agent mode — dispatch disabled]']);
      expect(message, pickedMode).not.toContain('Turn receipt context');
      expect(message, pickedMode).not.toContain('create_mission');
      expect(message, pickedMode).not.toContain('cortex_launch_agent');
      expect(message.endsWith('\n\nFix the footer'), pickedMode).toBe(true);
    }
  });

  it('keeps the composer directive and receipt on a Multitask fleet turn', async () => {
    vi.stubEnv('O8_DATA_DIR', mkdtempSync(join(tmpdir(), 'o8-fleet-banner-')));
    const message = await sendComposerTurn('multitask', 'fleet');
    expect(message.match(MODE_BANNER)).toEqual(['[Mode: Multitask]']);
    expect(message).toContain('orchestratorTurnId: "assistant-banner"');
    expect(message).toContain('cortex_launch_agent');
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
