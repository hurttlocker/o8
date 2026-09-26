import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ensureSharedCheckoutTeam, finishSharedCheckoutTeam, inspectSharedCheckoutTeam, readSharedCheckoutTeam, recordSharedCheckoutMember, reserveSharedCheckoutMember } from './shared-checkout-team';
import { findOwnedLaunchByMutationId, ownedRoots } from '@/lib/runtimes/shared/owned-session-index';

const roots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'o8-shared-team-'));
  roots.push(root);
  const repoPath = join(root, 'repo');
  mkdirSync(repoPath);
  git(repoPath, 'init', '-b', 'main');
  writeFileSync(join(repoPath, 'README.md'), '# fixture\n');
  git(repoPath, 'add', 'README.md');
  git(repoPath, '-c', 'user.name=o8 test', '-c', 'user.email=test@o8.local', 'commit', '-m', 'fixture');
  return { root, repoPath };
}

afterEach(() => {
  vi.unstubAllEnvs();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('shared checkout team', () => {
  it('gives two workers from one orchestrator one durable checkout and distinct members', async () => {
    const { root, repoPath } = fixture();
    const input = { repoPath, parentThreadId: 'thoughts-team-a', dataDir: join(root, 'state') };
    const [first, second] = await Promise.all([
      ensureSharedCheckoutTeam(input),
      ensureSharedCheckoutTeam(input),
    ]);
    expect(first.path).toBe(realpathSync(repoPath));
    expect(first.path).toBe(second.path);
    expect(first.branch).toBe('main');
    expect(git(first.path, 'rev-parse', '--show-toplevel')).toBe(first.path);
    expect(git(first.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(first.branch);

    await reserveSharedCheckoutMember({ ...input, runtime: 'codex', taskName: 'A', clientMutationId: 'a', paths: ['src/a'] });
    await reserveSharedCheckoutMember({ ...input, runtime: 'codex', taskName: 'B', clientMutationId: 'b', paths: ['src/b'] });
    await recordSharedCheckoutMember({ ...input, surfaceId: 'codex-owned:a', runtime: 'codex', taskName: 'A', clientMutationId: 'a' });
    await recordSharedCheckoutMember({ ...input, surfaceId: 'codex-owned:b', runtime: 'codex', taskName: 'B', clientMutationId: 'b' });
    const restored = readSharedCheckoutTeam(input);
    expect(restored?.members.map((member) => member.surfaceId)).toEqual(['codex-owned:a', 'codex-owned:b']);
    await expect(reserveSharedCheckoutMember({ ...input, runtime: 'codex', taskName: 'C', clientMutationId: 'c', paths: ['src/a/file.ts'] }))
      .rejects.toThrow(/overlaps worker A/);
    mkdirSync(join(repoPath, 'src'));
    writeFileSync(join(repoPath, 'src', 'a'), 'A\n');
    writeFileSync(join(repoPath, 'src', 'outside'), 'outside\n');
    expect(inspectSharedCheckoutTeam(input)).toMatchObject({
      newPaths: ['src/a', 'src/outside'],
      outsideClaims: ['src/outside'],
      scopeClean: false,
      baselineClean: true,
    });
  });

  it('holds another orchestrator from the same checkout and fails if ownership drifts', async () => {
    const { root, repoPath } = fixture();
    const dataDir = join(root, 'state');
    const first = await ensureSharedCheckoutTeam({ repoPath, parentThreadId: 'thoughts-a', dataDir });
    await expect(ensureSharedCheckoutTeam({ repoPath, parentThreadId: 'thoughts-b', dataDir }))
      .rejects.toThrow(/owned by another orchestrator/);
    git(first.path, 'checkout', '--detach');
    await expect(ensureSharedCheckoutTeam({ repoPath, parentThreadId: 'thoughts-a', dataDir }))
      .rejects.toThrow(/branch changed/);
  });

  it('protects existing dirty files and notices commits outside assigned worker paths', async () => {
    const { root, repoPath } = fixture();
    mkdirSync(join(repoPath, 'src'));
    writeFileSync(join(repoPath, 'src', 'existing'), 'operator edit\n');
    const input = { repoPath, parentThreadId: 'thoughts-team-a', dataDir: join(root, 'state') };
    await ensureSharedCheckoutTeam(input);
    await expect(reserveSharedCheckoutMember({ ...input, runtime: 'codex', taskName: 'A', clientMutationId: 'a', paths: ['src'] }))
      .rejects.toThrow(/dirty before the team/);
    await reserveSharedCheckoutMember({ ...input, runtime: 'codex', taskName: 'A', clientMutationId: 'a', paths: ['docs/a'] });
    writeFileSync(join(repoPath, 'outside.md'), 'outside\n');
    git(repoPath, 'add', 'outside.md');
    git(repoPath, '-c', 'user.name=o8 test', '-c', 'user.email=test@o8.local', 'commit', '-m', 'Outside');
    expect(inspectSharedCheckoutTeam(input)?.outsideClaims).toEqual(['outside.md']);
  });

  it('rejects a path scope that resolves outside the checkout', async () => {
    const { root, repoPath } = fixture();
    const input = { repoPath, parentThreadId: 'thoughts-team-a', dataDir: join(root, 'state') };
    symlinkSync(root, join(repoPath, 'elsewhere'));
    await ensureSharedCheckoutTeam(input);
    await expect(reserveSharedCheckoutMember({ ...input, runtime: 'codex', taskName: 'A', clientMutationId: 'a', paths: ['elsewhere/output'] }))
      .rejects.toThrow(/escapes the checkout/);
  });

  it('does not claim the checkout when the first reservation is invalid', async () => {
    const { root, repoPath } = fixture();
    const input = { repoPath, parentThreadId: 'thoughts-team-a', dataDir: join(root, 'state') };
    mkdirSync(join(repoPath, 'src'));
    writeFileSync(join(repoPath, 'src', 'existing'), 'operator edit\n');
    await expect(reserveSharedCheckoutMember({ ...input, runtime: 'codex', taskName: 'A', clientMutationId: 'a', paths: ['src'] }))
      .rejects.toThrow(/dirty before the team/);
    expect(readSharedCheckoutTeam(input)).toBeNull();
    symlinkSync(root, join(repoPath, 'elsewhere'));
    await expect(reserveSharedCheckoutMember({ ...input, runtime: 'codex', taskName: 'B', clientMutationId: 'b', paths: ['elsewhere/output'] }))
      .rejects.toThrow(/escapes the checkout/);
    expect(readSharedCheckoutTeam(input)).toBeNull();
  });

  it('detects changes to pre-existing operator edits even when their paths remain dirty', async () => {
    const { root, repoPath } = fixture();
    writeFileSync(join(repoPath, 'operator.txt'), 'original edit\n');
    const input = { repoPath, parentThreadId: 'thoughts-team-a', dataDir: join(root, 'state') };
    await reserveSharedCheckoutMember({ ...input, runtime: 'codex', taskName: 'A', clientMutationId: 'a', paths: ['src/a'] });
    expect(inspectSharedCheckoutTeam(input)?.baselineDrift).toEqual([]);
    writeFileSync(join(repoPath, 'operator.txt'), 'worker changed operator edit\n');
    expect(inspectSharedCheckoutTeam(input)).toMatchObject({ baselineDrift: ['operator.txt'], scopeClean: false });
  });

  it('releases ownership only after the owned worker settles and its scoped edits are reviewed and committed', async () => {
    const { root, repoPath } = fixture();
    const input = { repoPath, parentThreadId: 'thoughts-team-a', dataDir: join(root, 'state') };
    const ownedRoot = join(root, 'owned-codex');
    vi.stubEnv('CORTEX_IDE_OWNED_CODEX_ROOT', ownedRoot);
    await ensureSharedCheckoutTeam(input);
    await reserveSharedCheckoutMember({ ...input, runtime: 'codex', taskName: 'A', clientMutationId: 'a', paths: ['src/a'] });
    await recordSharedCheckoutMember({ ...input, surfaceId: 'codex-owned:a', runtime: 'codex', taskName: 'A', clientMutationId: 'a' });
    mkdirSync(join(ownedRoot, 'a'), { recursive: true });
    const sessionPath = join(ownedRoot, 'a', 'session.json');
    const session = { surfaceId: 'codex-owned:a', cwd: realpathSync(repoPath), repoPath: realpathSync(repoPath), launchMutationId: 'a' };
    writeFileSync(sessionPath, JSON.stringify({ ...session, activeRun: { pid: 123, outcome: 'running' } }));
    expect(ownedRoots()[0]?.root).toBe(ownedRoot);
    expect(await findOwnedLaunchByMutationId('a')).toMatchObject({ surfaceId: 'codex-owned:a', outcome: 'running' });
    const finish = { ...input, reviewSummary: 'Reviewed worker A diff.', verification: 'Focused test passed.' };
    await expect(finishSharedCheckoutTeam(finish)).rejects.toThrow(/still active/);
    writeFileSync(sessionPath, JSON.stringify({ ...session, recentRuns: [{ outcome: 'finished' }] }));
    mkdirSync(join(repoPath, 'src'));
    writeFileSync(join(repoPath, 'src', 'a'), 'A\n');
    await expect(finishSharedCheckoutTeam(finish)).rejects.toThrow(/uncommitted/);
    git(repoPath, 'add', 'src/a');
    git(repoPath, '-c', 'user.name=o8 test', '-c', 'user.email=test@o8.local', 'commit', '-m', 'Add A');
    expect(inspectSharedCheckoutTeam(input)?.committedPaths).toEqual(['src/a']);
    const result = await finishSharedCheckoutTeam(finish);
    expect(result.committedPaths).toEqual(['src/a']);
    expect(readSharedCheckoutTeam(input)).toBeNull();
    expect((await ensureSharedCheckoutTeam({ ...input, parentThreadId: 'thoughts-team-b' })).parentThreadId)
      .toBe('thoughts-team-b');
  });
});
