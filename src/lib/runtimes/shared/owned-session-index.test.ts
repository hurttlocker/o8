/**
 * Shared owned-session index — semantics + memoization (perf, 2026-07-03).
 * Pins the three-way return contract the liveness probes depend on, and that
 * the 2s TTL shares one readdir instead of re-scanning per lookup.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  listOwnedActiveRuns,
  lookupOwnedActiveRun,
  lookupOwnedActiveRunFresh,
  resetOwnedSessionIndex,
} from './owned-session-index';

let root = '';
function writeSession(dir: string, surfaceId: string, activeRun: unknown) {
  const d = join(root, dir);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'session.json'), JSON.stringify({ surfaceId, ...(activeRun !== undefined ? { activeRun } : {}) }));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'o8-owned-idx-'));
  process.env.CORTEX_IDE_OWNED_CODEX_ROOT = root;
  process.env.CORTEX_IDE_OWNED_CLAUDE_CODE_ROOT = root;
  process.env.O8_OWNED_GEMINI_ROOT = root;
  process.env.O8_OWNED_OPENCODE_ROOT = root;
  process.env.O8_OWNED_CURSOR_ROOT = root;
  process.env.O8_OWNED_GROK_ROOT = root;
  process.env.O8_OWNED_PRIME_AGENT_ROOT = root;
  process.env.O8_OWNED_PI_ROOT = root;
  resetOwnedSessionIndex();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.CORTEX_IDE_OWNED_CODEX_ROOT;
  delete process.env.CORTEX_IDE_OWNED_CLAUDE_CODE_ROOT;
  delete process.env.O8_OWNED_GEMINI_ROOT;
  delete process.env.O8_OWNED_OPENCODE_ROOT;
  delete process.env.O8_OWNED_CURSOR_ROOT;
  delete process.env.O8_OWNED_GROK_ROOT;
  delete process.env.O8_OWNED_PRIME_AGENT_ROOT;
  delete process.env.O8_OWNED_PI_ROOT;
  resetOwnedSessionIndex();
});

describe('lookupOwnedActiveRun', () => {
  it('null when the surface is not present under its root', async () => {
    expect(await lookupOwnedActiveRun('codex-owned:absent', 1000)).toBeNull();
  });

  it('{} when present but activeRun is cleared (definitively dead)', async () => {
    writeSession('s1', 'codex-owned:cleared', undefined);
    resetOwnedSessionIndex();
    expect(await lookupOwnedActiveRun('codex-owned:cleared', 1000)).toEqual({});
  });

  it('returns the run (pid/tmux) when present with an active run', async () => {
    writeSession('s2', 'codex-owned:live', { pid: 4242, tmuxSession: 'sess-x' });
    resetOwnedSessionIndex();
    expect(await lookupOwnedActiveRun('codex-owned:live', 1000)).toEqual({ pid: 4242, tmuxSession: 'sess-x' });
  });

  it('lists active runs once and omits cleared session metadata', async () => {
    writeSession('s-live', 'codex-owned:list-live', { pid: 99 });
    writeSession('s-cleared', 'codex-owned:list-cleared', undefined);
    resetOwnedSessionIndex();
    expect(await listOwnedActiveRuns(1000)).toEqual([
      { surfaceId: 'codex-owned:list-live', pid: 99, tmuxSession: undefined },
    ]);
  });

  it('indexes Claude Code owned workers under their own root marker', async () => {
    writeSession('s-claude', 'claude-code-owned:live', { pid: 31337 });
    resetOwnedSessionIndex();
    expect(await lookupOwnedActiveRun('claude-code-owned:live', 1000)).toEqual({ pid: 31337, tmuxSession: undefined });
  });

  it('indexes every registry-backed owned worker prefix', async () => {
    const surfaces = [
      'gemini-owned:live',
      'opencode-owned:live',
      'cursor-owned:live',
      'grok-owned:live',
      'prime-agent-owned:live',
      'pi-owned:live',
    ];
    surfaces.forEach((surfaceId, index) => writeSession(`owned-${index}`, surfaceId, { pid: 5000 + index }));
    resetOwnedSessionIndex();

    for (const [index, surfaceId] of surfaces.entries()) {
      expect(await lookupOwnedActiveRun(surfaceId, 1000)).toEqual({ pid: 5000 + index, tmuxSession: undefined });
    }
  });

  it('null for a surfaceId that matches no known root marker', async () => {
    expect(await lookupOwnedActiveRun('claude-code:live-1', 1000)).toBeNull();
  });

  it('memoizes within the TTL — a write after the first scan is not seen until TTL expiry', async () => {
    const t0 = 1_700_000_000_000;
    expect(await lookupOwnedActiveRun('codex-owned:new', t0)).toBeNull(); // scan #1, empty
    writeSession('s3', 'codex-owned:new', { pid: 7 });
    // Within TTL: still the cached (empty) index.
    expect(await lookupOwnedActiveRun('codex-owned:new', t0 + 1_000)).toBeNull();
    // Past the 2s TTL: fresh scan sees it.
    expect(await lookupOwnedActiveRun('codex-owned:new', t0 + 2_100)).toEqual({ pid: 7 });
  });

  it('bypasses a stale miss for safety-critical kill decisions', async () => {
    const t0 = 1_700_000_000_000;
    expect(await lookupOwnedActiveRun('pi-owned:new', t0)).toBeNull();
    writeSession('pi-new', 'pi-owned:new', { pid: 8 });

    expect(await lookupOwnedActiveRunFresh('pi-owned:new')).toEqual({ pid: 8, tmuxSession: undefined });
  });

  it('preserves the latest exact run marker through a fresh stop lookup', async () => {
    const surfaceId = 'claude-code-owned:marker';
    writeSession('marker', surfaceId, { pid: 8, processMarker: 'old-run' });
    expect(await lookupOwnedActiveRun(surfaceId)).toMatchObject({ processMarker: 'old-run' });
    writeSession('marker', surfaceId, {
      pid: 9, processGroupId: 9, commandIdentity: 'sandbox-exec', processMarker: 'new-run',
    });
    expect(await lookupOwnedActiveRunFresh(surfaceId)).toMatchObject({
      pid: 9, processGroupId: 9, commandIdentity: 'sandbox-exec', processMarker: 'new-run',
    });
  });
});
