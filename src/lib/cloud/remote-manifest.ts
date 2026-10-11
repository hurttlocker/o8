import 'server-only';

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

import { getOperatorDefaults } from '@/lib/operator/defaults';
import { parseWorkspaceManifest } from '@/lib/workspace/manifest/schema';
import { WORKSPACE_MANIFEST_FILENAME } from '@/lib/workspace/manifest/types';
import { resolveWorkspaceManifestExecution } from '@/lib/workspace/manifest/policy';
import { remotePreviewService } from './preview-contract';

const GIT_OPTIONS = { encoding: 'buffer' as const, timeout: 5_000, maxBuffer: 256 * 1024 };

/** Authorize exactly the manifest bytes in the remote job's immutable base revision. */
export async function resolveRemoteWorkspaceManifest(repoPath: string, baseSha: string) {
  const object = `${baseSha}:${WORKSPACE_MANIFEST_FILENAME}`;
  const names = execFileSync('git', ['-C', repoPath, 'ls-tree', '--name-only', baseSha, '--', WORKSPACE_MANIFEST_FILENAME], GIT_OPTIONS);
  if (!names.toString('utf8').trim()) return {};
  let source: Buffer;
  try {
    source = execFileSync('git', ['-C', repoPath, 'show', object], GIT_OPTIONS);
  } catch {
    throw new Error('The remote workspace manifest could not be read from the dispatched revision.');
  }
  const manifest = parseWorkspaceManifest(JSON.parse(source.toString('utf8')) as unknown);
  const hash = createHash('sha256').update(source).digest('hex');
  const policy = (await getOperatorDefaults()).values.workspaceManifestPolicy;
  if (policy === 'disabled') return {};
  const decision = await resolveWorkspaceManifestExecution({ repoPath, manifestSource: source, policy });
  if (!decision.allowed || decision.manifestHash !== hash) {
    throw new Error('Remote workspace services require approval of the exact dispatched manifest bytes before launch.');
  }
  return { remoteManifestHash: hash, remotePreview: remotePreviewService(manifest) };
}

export async function resolveRemoteManifestHash(repoPath: string, baseSha: string): Promise<string | undefined> {
  return (await resolveRemoteWorkspaceManifest(repoPath, baseSha)).remoteManifestHash;
}
