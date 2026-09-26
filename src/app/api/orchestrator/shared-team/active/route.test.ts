import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ensureSharedCheckoutTeam,
  recordSharedCheckoutMember,
  reserveSharedCheckoutMember,
} from '@/lib/orchestrator/shared-checkout-team';
import { GET } from './route';
import { getOrCreateWsToken } from '@/lib/ws-auth';

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('active Fast team workspace read', () => {
  it('returns the persisted running member for native pane restoration', async () => {
    const root = mkdtempSync(join(tmpdir(), 'o8-fast-placement-'));
    roots.push(root);
    const repoPath = join(root, 'repo');
    mkdirSync(repoPath);
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoPath });
    writeFileSync(join(repoPath, 'README.md'), '# fixture\n');
    execFileSync('git', ['add', 'README.md'], { cwd: repoPath });
    execFileSync('git', ['-c', 'user.name=o8 test', '-c', 'user.email=test@o8.local', 'commit', '-m', 'fixture'], { cwd: repoPath });
    vi.stubEnv('O8_DATA_DIR', join(root, 'state'));
    const input = { repoPath, parentThreadId: 'thoughts-fast-parent' };
    await ensureSharedCheckoutTeam(input);
    await reserveSharedCheckoutMember({ ...input, runtime: 'codex', taskName: 'Worker A', clientMutationId: 'a', paths: ['src/a'] });
    await recordSharedCheckoutMember({ ...input, surfaceId: 'codex-owned:fast-a', runtime: 'codex', taskName: 'Worker A', clientMutationId: 'a' });
    const ownedSessionDir = join(root, 'state', 'owned-codex', 'fast-a');
    mkdirSync(ownedSessionDir, { recursive: true });
    vi.stubEnv('CORTEX_IDE_OWNED_CODEX_ROOT', join(root, 'state', 'owned-codex'));
    writeFileSync(join(ownedSessionDir, 'session.json'), JSON.stringify({
      launchMutationId: 'a', surfaceId: 'codex-owned:fast-a', cwd: realpathSync(repoPath),
      repoPath: realpathSync(repoPath), recentRuns: [{ outcome: 'finished' }],
    }));

    const response = await GET(new NextRequest(
      `http://localhost/api/orchestrator/shared-team/active?repoPath=${encodeURIComponent(repoPath)}`,
      { headers: { authorization: `Bearer ${getOrCreateWsToken()}` } },
    ));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ team: {
      repoPath: realpathSync(repoPath),
      parentThreadId: 'thoughts-fast-parent',
      members: [{ surfaceId: 'codex-owned:fast-a', runtime: 'codex', taskName: 'Worker A', state: 'running', outcome: 'finished' }],
    } });
  });
});
