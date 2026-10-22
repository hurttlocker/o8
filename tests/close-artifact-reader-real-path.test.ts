import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { captureWorktreeMaterializationIdentity } from '@/lib/worktree/materialization-identity';
import {
  captureIgnoredArtifacts, closeArtifactReaderDiagnostics, inspectArtifactRestoreRevision,
  UnbankedArtifactSourceError, withCloseArtifactReader,
} from '@/lib/workspace/ignored-artifact-io';

const root = mkdtempSync(path.join(tmpdir(), 'o8-close-artifact-reader-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function fixture(label: string) {
  const workspacePath = path.join(root, label);
  mkdirSync(workspacePath);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: workspacePath, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'o8-test');
  git('config', 'user.email', 'o8@example.test');
  writeFileSync(path.join(workspacePath, 'source.txt'), label);
  git('add', 'source.txt');
  git('commit', '-qm', 'fixture');
  return { workspacePath, identity: await captureWorktreeMaterializationIdentity(workspacePath),
    headCommit: git('rev-parse', 'HEAD'), treeSha: git('rev-parse', 'HEAD^{tree}'),
    rebuildablePaths: [], copiedEnvironment: {} };
}

describe('close-scoped artifact reader through native pinned directories', () => {
  it('serializes reads of different exact workspaces in one helper and observes its exit', async () => {
    const first = await fixture('first');
    const second = await fixture('second');
    let helperPid = 0;
    await withCloseArtifactReader(async () => {
      const [revision, capture] = await Promise.all([
        inspectArtifactRestoreRevision(first), captureIgnoredArtifacts(second),
      ]);
      expect(revision).toEqual({ headCommit: first.headCommit, treeSha: first.treeSha });
      expect(capture).toMatchObject({ headCommit: second.headCommit, treeSha: second.treeSha, entries: [] });
      const diagnostics = closeArtifactReaderDiagnostics();
      expect(diagnostics?.starts).toBe(1);
      helperPid = diagnostics!.pid!;
    });
    expect(() => process.kill(helperPid, 0)).toThrow();
  });

  it('settles a refused reader before rejecting and never reuses it', async () => {
    const source = await fixture('refused');
    writeFileSync(path.join(source.workspacePath, 'source.txt'), 'unbanked source');
    await withCloseArtifactReader(async () => {
      await expect(captureIgnoredArtifacts({ ...source, discardSource: true, requireCleanSource: true }))
        .rejects.toBeInstanceOf(UnbankedArtifactSourceError);
      const diagnostics = closeArtifactReaderDiagnostics()!;
      expect(() => process.kill(diagnostics.pid!, 0)).toThrow();
      await expect(inspectArtifactRestoreRevision(source)).rejects.toThrow('expired or was refused');
      expect(closeArtifactReaderDiagnostics()?.starts).toBe(1);
    });
  });
});
