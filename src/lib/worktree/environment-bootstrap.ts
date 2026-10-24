import { access } from 'node:fs/promises';
import path from 'node:path';
import {
  createPinnedWorkspaceBinding,
  inspectPinnedWorkspaceEntry,
  isPinnedWorkspacePublishError,
} from './materialization-leaf-io';
import type { WorktreeMaterializationIdentity } from './materialization-identity';
import { withWorktreeMetaTransaction } from './metadata-store';
import type { CreateWorktreeOptions } from './types';

/** Standalone bootstrapping stays explicit; packets never inherit writable source references. */
export async function bootstrapEnvironmentFiles(
  repoRoot: string,
  worktreePath: string,
  identity: WorktreeMaterializationIdentity,
  opts: CreateWorktreeOptions,
): Promise<void> {
  const envMode = opts.envMode === 'skip' ? 'skip' : opts.packetId ? 'symlink' : opts.envMode ?? 'copy';
  if (envMode === 'skip') return;

  const envFiles = opts.envFiles?.filter(Boolean) ?? ['.env', '.env.local'];
  for (const configuredPath of envFiles) {
    const envFile = configuredPath.trim().replaceAll('\\', '/').replace(/^\.\//, '');
    if (!envFile || path.isAbsolute(envFile)
      || envFile.split('/').some((part) => !part || part === '.' || part === '..' || part === '.git')) {
      throw new Error('Environment bootstrap requires a safe repository-relative path.');
    }
    // A runtime name is not proof of enforced write isolation. Existing local
    // files are task configuration, but links can still write into the source.
    if (opts.packetId) {
      const destination = await inspectPinnedWorkspaceEntry(worktreePath, identity, envFile);
      if (destination?.kind === 'file') continue;
      if (destination || await resolveEnvBootstrapSource(repoRoot, envFile)) {
        throw new Error('Packet environment inheritance is unsafe: source environment files cannot be linked or copied into a worker checkout. Set repository envMode: skip and provide task-scoped configuration before retrying.');
      }
      continue;
    }
    const sourcePath = await resolveEnvBootstrapSource(repoRoot, envFile);
    if (!sourcePath) continue;

    let result: Awaited<ReturnType<typeof createPinnedWorkspaceBinding>>;
    try {
      result = await createPinnedWorkspaceBinding(worktreePath, identity, envFile, {
        mode: envMode === 'symlink' ? 'symlink' : 'copy-file',
        source: sourcePath,
      });
    } catch (error) {
      if (isPinnedWorkspacePublishError(error)) throw error;
      // Keep env bootstrap best-effort; missing env should show in readiness instead of killing creation.
      continue;
    }
    if (envMode === 'symlink' && result === 'created') {
      await withWorktreeMetaTransaction(repoRoot, async (transaction) => {
        const id = path.basename(worktreePath);
        const entry = (await transaction.readAll())[id];
        if (!entry) throw new Error('Environment reference lost its managed workspace owner.');
        entry.environmentReferences = { ...entry.environmentReferences, [envFile]: sourcePath };
        await transaction.save(id, entry);
      });
    }
  }
}

async function resolveEnvBootstrapSource(repoRoot: string, envFile: string): Promise<string | null> {
  for (const name of envFile === '.env' ? [envFile, '.env.local'] : [envFile]) {
    const source = path.join(repoRoot, name);
    if (await access(source).then(() => true, () => false)) return source;
  }
  return null;
}
