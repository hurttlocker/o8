import os from 'node:os';
import { readPinnedWorkspaceFile } from './materialization-leaf-io';
import type { WorktreeMaterializationIdentity } from './materialization-identity';
import { materializationAwareExecFile } from './materialization-execution';
import path from 'node:path';
import { getLane } from '@/lib/lane/registry';
import { canonicalRepoRoot, worktreeRepoKey } from './root-layout';

export function repositoryCargoTargetDirectory(repoPath: string): string {
  return path.join(os.homedir(), '.cache', 'o8', 'cargo-targets', worktreeRepoKey(repoPath));
}

/** Derive the cache from durable ownership, never the packet clone's unique path. */
export function packetCargoEnvironment(session: {
  laneId?: string; packetId?: string; repoPath: string; executionPolicy?: unknown;
}): Record<string, string> {
  if (session.executionPolicy !== undefined || !session.laneId || !session.packetId) return {};
  const lane = getLane(session.laneId);
  if (!lane || lane.packetId !== session.packetId || lane.ownership !== 'managed'
    || !lane.worktreePath || canonicalRepoRoot(lane.worktreePath) !== canonicalRepoRoot(session.repoPath)) return {};
  return { CARGO_TARGET_DIR: repositoryCargoTargetDirectory(lane.repoPath) };
}

/** Only a tracked Cargo project with Cargo's explicit disposable-cache tag qualifies. */
export async function rebuildableCargoTargetPaths(workspacePath: string, identity: WorktreeMaterializationIdentity): Promise<string[]> {
  const result: string[] = [];
  for (const directory of ['', 'src-tauri']) {
    const manifest = path.posix.join(directory, 'Cargo.toml');
    const target = path.posix.join(directory, 'target');
    try {
      await materializationAwareExecFile('git', ['ls-files', '--error-unmatch', '--', manifest], {
        cwd: workspacePath, timeout: 5_000, windowsHide: true,
      });
      const tag = await readPinnedWorkspaceFile(workspacePath, identity, path.posix.join(target, 'CACHEDIR.TAG'));
      if (tag?.startsWith('Signature: 8a477f597d28d172789f06886806bc55')) result.push(target);
    } catch {
      // Untagged or unproved directories retain the ordinary unique-content policy.
    }
  }
  return result;
}
