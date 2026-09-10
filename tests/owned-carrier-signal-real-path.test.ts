import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OwnedRuntimeAdapter, ParsedRunLog } from '@/lib/runtimes/shared/owned-session/types';

const roots: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe.skipIf(process.platform === 'win32')('owned carrier signal authority through the session store', () => {
  it.each(['unmarked', 'wrong-marker', 'wrong-group', 'exec-replaced'] as const)(
    '%s uses persisted run ownership instead of an argv mention', async (scenario) => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'o8-owned-carrier-signal-'));
      roots.push(root);
      const sessions = path.join(root, 'sessions');
      const sessionDir = path.join(sessions, 'fixture');
      mkdirSync(path.join(sessionDir, 'runs'), { recursive: true });
      vi.stubEnv('O8_TEST_CARRIER_SIGNAL_ROOT', sessions);
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '/tools/ori'], {
        detached: true, stdio: 'ignore',
        env: { NODE_ENV: 'test', PATH: process.env.PATH, O8_OWNED_RUN_MARKER: 'carrier-signal-actual' },
      });
      children.push(child);
      await once(child, 'spawn');
      const pid = child.pid!;
      const surfaceId = 'carrier-signal-owned:fixture';
      const now = new Date().toISOString();
      const run = {
        id: 'carrier-signal-actual', mode: 'launch', prompt: 'fixture', startedAt: now,
        pid, processGroupId: scenario === 'wrong-group' ? pid + 1 : pid,
        processMarker: scenario === 'unmarked' ? undefined
          : scenario === 'wrong-marker' ? 'carrier-signal-stale' : 'carrier-signal-actual',
        commandIdentity: '/tools/ori', spawnState: 'started', outcome: 'running',
        stdoutPath: path.join(sessionDir, 'runs', 'stdout.jsonl'),
        stderrPath: path.join(sessionDir, 'runs', 'stderr.log'),
      };
      writeFileSync(run.stdoutPath, '');
      writeFileSync(run.stderrPath, '');
      const metadata = path.join(sessionDir, 'session.json');
      writeFileSync(metadata, JSON.stringify({
        surfaceId, sessionDir, runtimeId: 'test-runtime', repoPath: root,
        createdAt: now, updatedAt: now, activeRun: run, recentRuns: [run],
      }));
      const adapter: OwnedRuntimeAdapter = {
        runtimeId: 'test-runtime', surfaceIdPrefix: 'carrier-signal-owned:',
        rootEnvVar: 'O8_TEST_CARRIER_SIGNAL_ROOT', rootDefault: sessions,
        binaryName: 'node', binaryEnvOverride: 'O8_TEST_CARRIER_SIGNAL_BIN',
        humanLabel: 'Signal fixture', squadShortName: 'Test',
        launchArgs: () => [], resumeArgs: () => [],
        parseRunLog: (): ParsedRunLog => ({ entries: [], outcome: 'running', completedTurn: false }),
      };
      const { createOwnedSessionStore } = await import('@/lib/runtimes/shared/owned-session/store');
      const store = createOwnedSessionStore(adapter);
      const result = await store.interrupt(surfaceId);
      const persisted = JSON.parse(readFileSync(metadata, 'utf8'));
      if (scenario === 'exec-replaced') {
        expect(result.interrupted).toBe(true);
        expect(persisted.recentRuns[0].interruptRequestedAt).toEqual(expect.any(String));
        if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
        expect(child.signalCode).toBe('SIGINT');
      } else {
        expect(result).toMatchObject({ interrupted: false });
        expect(persisted.activeRun.interruptRequestedAt).toBeUndefined();
        expect(persisted.activeRun.pid).toBe(pid);
        expect(() => process.kill(pid, 0)).not.toThrow();
      }
    }, 15_000,
  );
});
