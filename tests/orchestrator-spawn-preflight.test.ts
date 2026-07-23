/**
 * #1551 — BOTH orchestrator spawn paths preflight the repo path (exists + is a
 * Git work tree) before any spawn work.
 *
 * Field incident (Sydney FKAR3B/6JWBVV): a moved repo folder surfaced as
 * "spawn …/claude ENOENT" — naming the healthy binary — and the DEFAULT
 * (codex) backend had no preflight at all, so a plain non-git folder let the
 * CLI boot and fail into a confusing tool-side error mid-turn.
 *
 * Both tests run through the REAL turn entry points (sendToCodexOrchestrator /
 * sendToOrchestrator). The CLI env overrides point at a nonexistent binary so
 * OLD code (no preflight) fails with a binary-shaped error instead — which
 * fails these assertions — and no real CLI is ever spawned by the test.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-spawn-preflight-'));
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_CODEX_BIN = '/nonexistent/o8-test/codex';
process.env.O8_CLAUDE_CODE_BIN = '/nonexistent/o8-test/claude';

const { ensureCodexOrchestratorSession, sendToCodexOrchestrator } = await import('@/lib/lane/codex-orchestrator-session');
const { ensureOrchestratorSession, sendToOrchestrator } = await import('@/lib/lane/orchestrator-session');
import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';

function makeNonGitDir(name: string): string {
  const dir = join(dataDir, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeGitDir(name: string): string {
  const dir = makeNonGitDir(name);
  execFileSync('git', ['init', '-q', dir]);
  return dir;
}

describe('#1551 — codex orchestrator (the default backend) preflights the repo path', () => {
  it('rejects a non-git folder with an actionable message, before any spawn', async () => {
    const repoPath = makeNonGitDir('codex-non-git');
    const session = ensureCodexOrchestratorSession(repoPath);
    const events: OrchestratorEvent[] = [];

    await sendToCodexOrchestrator(session, 'hello', (event) => events.push(event));

    const errorEvent = events.find((event) => event.type === 'error');
    expect(errorEvent && 'error' in errorEvent ? errorEvent.error : '').toContain('Git repository');
    expect(events.some((event) => event.type === 'done')).toBe(true);
    expect(session.status).toBe('dead');
  });

  it('rejects a missing folder naming the FOLDER, not the binary', async () => {
    const session = ensureCodexOrchestratorSession(join(dataDir, 'codex-vanished'));
    const events: OrchestratorEvent[] = [];

    await sendToCodexOrchestrator(session, 'hello', (event) => events.push(event));

    const errorEvent = events.find((event) => event.type === 'error');
    const message = errorEvent && 'error' in errorEvent ? errorEvent.error : '';
    expect(message).toContain('no longer exists');
    expect(message).not.toContain('ENOENT');
  });
});

describe('#1551 — claude orchestrator preflights the repo path', () => {
  it('rejects a non-git folder before resolving or spawning the binary', async () => {
    const repoPath = makeNonGitDir('claude-non-git');
    const session = ensureOrchestratorSession(repoPath);

    await expect(
      sendToOrchestrator(session, 'hello', () => {}),
    ).rejects.toThrow(/Git repository/);
  });

  it('reports a missing Claude binary distinctly after the repo preflight passes', async () => {
    const repoPath = makeGitDir('claude-git-ok');
    const session = ensureOrchestratorSession(repoPath);

    const error = await sendToOrchestrator(session, 'hello', () => {})
      .then(() => null, (thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('[runtime] Claude Code is not installed');
    expect(message).toContain('O8_CLAUDE_CODE_BIN');
    expect(message).not.toContain('ENOENT');
    expect(message).not.toContain('Git repository');
    expect(message).not.toContain('no longer exists');
  });
});
