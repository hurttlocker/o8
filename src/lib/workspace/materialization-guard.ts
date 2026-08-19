import path from 'node:path';

import { listRepos } from '@/lib/repos/registry';
import type {
  OwnedWorkspaceSpawnDecision,
  OwnedWorkspaceSpawnGuardInput,
} from '@/lib/runtimes/shared/owned-session/workspace-spawn-guard';
import { listWorkspaceSnapshotsByPacketId } from '@/lib/worktree/snapshot-state';
import type { WorkspaceSnapshotRecord } from '@/lib/worktree/snapshot-state';
import { materializeReplacementWorkspace } from './replacement-materialization';
import { assertManagedWorkspaceMaterialization } from './managed-materialization-identity';

interface MaterializationGuardDependencies {
  listRepos: () => Promise<Array<{ id: string; localPath: string }>>;
  assertManagedWorkspaceMaterialization: typeof assertManagedWorkspaceMaterialization;
}

const DEFAULT_DEPENDENCIES: MaterializationGuardDependencies = {
  listRepos,
  assertManagedWorkspaceMaterialization,
};

/** Durable gate used under an owned session's surface lock before any process spawn. */
export async function inspectOwnedWorkspaceMaterialization(
  input: OwnedWorkspaceSpawnGuardInput,
  dependencies = DEFAULT_DEPENDENCIES,
): Promise<OwnedWorkspaceSpawnDecision> {
  const sessionPacketId = input.sessionPacketId?.trim() || null;
  const bindingPacketId = input.binding?.packetId?.trim() || null;
  if (sessionPacketId && bindingPacketId && sessionPacketId !== bindingPacketId) {
    return { status: 'unknown', note: 'Owned workspace packet identity is inconsistent, so the run was refused.' };
  }
  const packetId = bindingPacketId ?? sessionPacketId;
  if (!packetId) return { status: 'available', source: 'no-snapshot' };
  if (!input.binding) {
    return { status: 'unknown', note: 'Packet-bound owned workspace binding is missing, so the run was refused.' };
  }

  let snapshots: WorkspaceSnapshotRecord[];
  try {
    snapshots = listWorkspaceSnapshotsByPacketId(packetId);
  } catch {
    return { status: 'unknown', note: 'Owned workspace snapshot truth could not be verified, so the run was refused.' };
  }
  if (snapshots.length === 0) {
    const bindingPath = path.resolve(input.binding.cwd);
    if (path.resolve(input.repoPath) !== bindingPath) {
      return { status: 'unknown', note: 'Owned workspace binding does not match its managed repository path.' };
    }
    try {
      const repositories = (await dependencies.listRepos()).filter((repo) => (
        input.binding!.repositoryUuid === null || repo.id === input.binding!.repositoryUuid
      ));
      const matches: Array<Awaited<ReturnType<typeof assertManagedWorkspaceMaterialization>>> = [];
      const refusals: string[] = [];
      for (const repository of repositories) {
        try {
          matches.push(await dependencies.assertManagedWorkspaceMaterialization(
            repository.localPath,
            bindingPath,
          ));
        } catch (error) {
          // This repository does not own the exact managed path.
          refusals.push(error instanceof Error ? error.message : String(error));
        }
      }
      if (matches.length !== 1) {
        // A single consulted repository refused for one exact, auditable
        // reason. Reporting registry ambiguity instead would send the
        // operator to the repo list rather than the replaced directory.
        throw new Error(matches.length === 0 && refusals.length === 1
          ? refusals[0]!
          : 'Managed workspace ownership is absent or ambiguous across registered repositories.');
      }
      const materializationIdentity = matches[0]!;
      return { status: 'available', source: 'materialized', materializationIdentity };
    } catch (error) {
      return {
        status: 'unknown',
        note: error instanceof Error ? error.message : 'Managed workspace ownership could not be verified.',
      };
    }
  }
  if (snapshots.length !== 1) {
    return { status: 'unknown', note: 'Owned workspace snapshot truth is ambiguous, so the run was refused.' };
  }

  let snapshot = snapshots[0]!;
  const bindingPath = path.resolve(input.binding.cwd);
  if (path.resolve(input.repoPath) !== bindingPath
    || path.resolve(snapshot.originalPath) !== bindingPath
    || (input.binding.repositoryUuid !== null
      && input.binding.repositoryUuid !== snapshot.repositoryUuid)) {
    return { status: 'unknown', note: 'Owned workspace snapshot identity does not match the durable session binding, so the run was refused.' };
  }
  if (input.mode === 'launch' && (snapshot.state === 'parked' || snapshot.state === 'materialized')) {
    const laneId = input.laneId?.trim();
    const runtimeId = input.runtimeId?.trim();
    if (!laneId || !runtimeId) {
      return { status: 'unknown', note: 'Replacement launch identity is incomplete, so the run was refused.' };
    }
    try {
      snapshot = await materializeReplacementWorkspace(snapshot, {
        laneId,
        packetId,
        workspacePath: bindingPath,
        runtimeId,
        surfaceId: input.surfaceId,
      });
    } catch (error) {
      return {
        status: 'unknown',
        note: error instanceof Error ? error.message : 'Replacement workspace truth could not be verified.',
      };
    }
  }
  if (snapshot.state === 'materialized') {
    try {
      const repo = (await dependencies.listRepos()).find((entry) => entry.id === snapshot.repositoryUuid);
      if (!repo) throw new Error('Managed workspace repository is absent.');
      const materializationIdentity = await dependencies.assertManagedWorkspaceMaterialization(
        repo.localPath,
        bindingPath,
      );
      return { status: 'available', source: 'materialized', materializationIdentity };
    } catch (error) {
      return {
        status: 'unknown',
        note: error instanceof Error ? error.message : 'Managed workspace ownership could not be verified.',
      };
    }
  }
  return {
    status: 'held',
    state: snapshot.state,
    note: `Owned workspace is ${snapshot.state}; restore it to materialized state before starting another run.`,
  };
}
