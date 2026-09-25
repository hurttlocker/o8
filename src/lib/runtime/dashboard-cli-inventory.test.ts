import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRuntime, RuntimeSession } from '@/lib/runtimes/types';

const previousDataDir = process.env.O8_DATA_DIR;
const dataDir = mkdtempSync(path.join(tmpdir(), 'o8-dashboard-cli-inventory-'));
process.env.O8_DATA_DIR = dataDir;
vi.resetModules();

afterEach(() => {
  vi.restoreAllMocks();
  if (previousDataDir === undefined) delete process.env.O8_DATA_DIR;
  else process.env.O8_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('dashboard CLI inventory persistence', () => {
  it('persists the exact live process ID with the terminal binding', async () => {
    const bindings = await import('./dashboard-cli-bindings');
    const sessionKey = 'codex:exact-bound-process';
    vi.spyOn(bindings, 'discoverDashboardCliBindings')
      .mockResolvedValue(new Map([[sessionKey, 'cortex-dash-exact-bound']]));
    const { registerDashboardCliBindings } = await import('./dashboard-cli-inventory');
    const session = {
      sessionKey, runtimeId: 'codex', displayName: 'Codex', cwd: '/repo',
      status: 'running', ownership: 'discovered', pid: process.pid,
      sessionCapabilities: { canSendInput: true, canInterrupt: false, canReviewDiffs: true },
      lastActivityAt: new Date(),
    } as RuntimeSession;

    await registerDashboardCliBindings([{ runtime: { id: 'codex' } as AgentRuntime, session }]);
    const persisted = JSON.parse(readFileSync(path.join(dataDir, 'runtime-terminal-sessions.json'), 'utf8'));
    expect(persisted[sessionKey]).toMatchObject({ sessionName: 'cortex-dash-exact-bound', pid: process.pid, source: 'dashboard-cli-detected' });
  });

  it('retains the last exact terminal observation after the CLI process exits', async () => {
    const { registerRuntimeTerminalSession, listRecentDashboardCliSessions } = await import('./terminal-session-registry');
    const { projectDashboardCliSession } = await import('./dashboard-cli-inventory');
    const session: RuntimeSession = {
      sessionKey: 'codex:01a0d4e6-42a3-7771-a56e-46d16a2868bd',
      runtimeId: 'codex',
      displayName: 'Codex',
      cwd: '/repo',
      status: 'idle',
      ownership: 'discovered',
      sessionCapabilities: { canSendInput: true, canInterrupt: false, canReviewDiffs: true },
      lastActivityAt: new Date(),
    };
    registerRuntimeTerminalSession(session.sessionKey, {
      sessionName: 'cortex-dash-existing',
      runtime: 'codex',
      cwd: '/repo',
      source: 'dashboard-cli-detected',
    });
    const persisted = JSON.parse(readFileSync(path.join(dataDir, 'runtime-terminal-sessions.json'), 'utf8'));
    expect(persisted[session.sessionKey].sessionName).toBe('cortex-dash-existing');
    expect(listRecentDashboardCliSessions('codex').map(({ sessionKey }) => sessionKey)).toContain(session.sessionKey);

    const projected = projectDashboardCliSession({ id: 'codex' } as AgentRuntime, session, new Map());
    expect(projected?.session).toMatchObject({ status: 'idle', tmuxSession: undefined });
    expect(projected?.statusEvidence).toMatchObject({
      state: 'unknown',
      authority: 'raw-terminal',
      observedAt: persisted[session.sessionKey].updatedAt,
    });
    expect(projected?.statusEvidence.fallbackReason).toContain('no longer verified');
  });
});
