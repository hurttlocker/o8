import 'server-only';
import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import { getWorkspaceSnapshot } from '@/lib/worktree/snapshot-state';
import { inspectArtifactRestoreRevision } from '@/lib/workspace/ignored-artifact-io';
import { inspectRetiredWorkspacePreservation } from '@/lib/workspace/preservation-restorer';
import type { CompletionHandoffRecord } from '@/lib/workspace/completion-handoff-store';
import type { PacketContext } from './types';

function quote(value: string): string { return "'" + value.replace(/'/g, "'\\''") + "'"; }

/** Availability is evaluated at read time; completion-time receipts stay immutable. */
export async function completionContextRecovery(record: CompletionHandoffRecord): Promise<PacketContext> {
  const unavailable = (): PacketContext => ({ ...record.context, recovery: { source: 'unavailable',
    instructions: 'Current recovery is unavailable: neither the exact retained source nor a verified portable preservation bank is available. The completion-time live-workspace instructions are historical. Retain the provider archive; do not assume transcript data or a recovery bundle exists.' } });
  const snapshot = getWorkspaceSnapshot(record.repositoryUuid, record.packetId);
  if (snapshot?.state !== 'retired') {
    try {
      const source = lstatSync(record.identity.canonicalPath);
      if (source.isDirectory() && !source.isSymbolicLink() && source.dev === record.identity.device
        && source.ino === record.identity.inode && realpathSync(record.identity.canonicalPath) === record.identity.canonicalPath) {
        const revision = await inspectArtifactRestoreRevision({ workspacePath: record.identity.canonicalPath, identity: record.identity });
        if (revision.headCommit === record.handoff.revision && revision.treeSha === record.handoff.treeSha) {
          return { ...record.context, recovery: { source: 'retained-source', instructions: record.handoff.recoveryInstructions } };
        }
      }
    } catch { /* Missing or substituted source is not executable recovery. */ }
    return unavailable();
  }
  try {
    const { payload, receipt } = await inspectRetiredWorkspacePreservation(record.repositoryUuid, record.packetId);
    const bundle = payload.gitBundle;
    if (!bundle || payload.laneId !== record.laneId || payload.worktreeId !== record.worktreeId
      || JSON.stringify(payload.identity) !== JSON.stringify(record.identity)
      || payload.capture.headCommit !== record.handoff.revision || payload.capture.treeSha !== record.handoff.treeSha
      || !payload.handoff.sessionIdentities.some((identity) => identity.kind === 'owned-session' && identity.identity === record.sessionKey)) return unavailable();
    const bank = quote(path.join(realpathSync(getDataDir()), 'workspace-preservation', 'git-bundles', bundle.sha256 + '.bundle'));
    const target = quote('<empty-successor-path>');
    const commands = `git init -q --object-format=${bundle.objectFormat} ${target} && git -C ${target} bundle verify ${bank} && git -C ${target} fetch -- ${bank} ${quote(bundle.recoveryRef)} && git -C ${target} checkout --detach ${quote(bundle.headCommit)} && test "$(git -C ${target} rev-parse HEAD)" = ${quote(bundle.headCommit)} && test "$(git -C ${target} rev-parse 'HEAD^{tree}')" = ${quote(bundle.treeSha)}`;
    return { ...record.context, recovery: { source: 'verified-preservation', preservationId: receipt.preservationId,
      bundleSha256: bundle.sha256,
      instructions: `Source has retired. Current recovery uses verified private preservation ${receipt.preservationId}, bundle SHA-256 ${bundle.sha256}; completion-time live-source instructions are historical. To recover committed source into a new empty directory: ${commands}. ${payload.handoff.recoveryInstructions}` } };
  } catch { return unavailable(); }
}
