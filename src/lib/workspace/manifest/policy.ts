import 'server-only';

import { createHash } from 'node:crypto';
import path from 'node:path';

import { createApproval, listApprovals } from '@/lib/approvals/store';
import type { ApprovalRecord } from '@/lib/approvals/types';
import { getDataDir } from '@/lib/data-dir-migration';
import type { WorkspaceManifestPolicy } from '@/lib/operator/defaults';
import {
  acquireMetadataTransactionLease,
  releaseMetadataTransactionLease,
} from '@/lib/worktree/metadata-transaction-lease';
import { parseWorkspaceManifest } from './schema';

const APPROVAL_ACTION = 'workspace_manifest_execution';
const POLICY_RULE_ID = 'workspace-manifest-one-approval';

export interface WorkspaceManifestExecutionDecision {
  allowed: boolean;
  reason: 'disabled' | 'approved' | 'auto' | 'awaiting_approval' | 'rejected';
  manifestHash: string;
}

function manifestHash(source: Uint8Array): string {
  return createHash('sha256').update(source).digest('hex');
}

function normalizedRepoPath(repoPath: string): string {
  return path.resolve(repoPath);
}

function manifestSessionKey(repoPath: string, hash: string): string {
  const repoIdentity = createHash('sha256').update(repoPath).digest('hex').slice(0, 12);
  return `workspace-manifest:${repoIdentity}:${hash}`;
}

function isManifestApproval(
  approval: ApprovalRecord,
  repoPath: string,
  hash: string,
): boolean {
  return approval.toolName === APPROVAL_ACTION
    && approval.args?.kind === 'lane'
    && approval.args?.action === APPROVAL_ACTION
    && approval.args?.repoPath === repoPath
    && approval.args?.manifestHash === hash;
}

export function findWorkspaceManifestApproval(
  repoPath: string,
  hash: string,
): ApprovalRecord | null {
  const normalized = normalizedRepoPath(repoPath);
  return listApprovals({
    status: 'all',
    sessionKey: manifestSessionKey(normalized, hash),
    projectId: null,
  })
    .find((approval) => isManifestApproval(approval, normalized, hash)) ?? null;
}

function codeFence(command: string): string {
  const longestRun = Math.max(0, ...Array.from(command.matchAll(/`+/g), (match) => match[0].length));
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}\n${command}\n${fence}`;
}

function commandBody(source: Uint8Array): string {
  const manifest = parseWorkspaceManifest(JSON.parse(Buffer.from(source).toString('utf8')) as unknown);
  const sections: string[] = [];
  if (manifest.setup?.length) {
    sections.push('Setup commands:', ...manifest.setup.map(codeFence));
  }
  if (manifest.services?.length) {
    sections.push(
      'Service commands:',
      ...manifest.services.flatMap((service) => [service.name, codeFence(service.command)]),
    );
  }
  if (manifest.teardown?.length) {
    sections.push('Teardown commands:', ...manifest.teardown.map(codeFence));
  }
  return sections.length > 0 ? sections.join('\n\n') : 'The manifest declares no commands.';
}

function createManifestApproval(repoPath: string, hash: string, source: Uint8Array): ApprovalRecord {
  const repoName = path.basename(repoPath);
  const reason = 'Run the checked-in workspace manifest commands after one operator approval.';
  return createApproval({
    source: 'runtime',
    runtime: 'system',
    agent: 'Workspace manifest policy',
    sessionKey: manifestSessionKey(repoPath, hash),
    title: `Run workspace manifest commands for ${repoName}`,
    description: [
      `Approve the checked-in o8.workspace.json commands for ${repoPath}.`,
      'This approval remains valid only while the manifest bytes keep the same SHA-256 hash.',
      commandBody(source),
    ].join('\n\n'),
    summary: `Approve workspace manifest execution for ${repoPath} at ${hash}.`,
    toolName: APPROVAL_ACTION,
    args: {
      kind: 'lane',
      action: APPROVAL_ACTION,
      reason,
      repoPath,
      manifestHash: hash,
    },
    risk: 'high',
    policyRuleId: POLICY_RULE_ID,
    metadata: {
      Repo: repoName,
      RepoPath: repoPath,
      'Manifest SHA-256': hash,
    },
  });
}

export async function resolveWorkspaceManifestExecution(input: {
  repoPath: string;
  manifestSource: Uint8Array;
  policy: WorkspaceManifestPolicy;
}): Promise<WorkspaceManifestExecutionDecision> {
  const repoPath = normalizedRepoPath(input.repoPath);
  const hash = manifestHash(input.manifestSource);
  if (input.policy === 'disabled') {
    return { allowed: false, reason: 'disabled', manifestHash: hash };
  }
  if (input.policy === 'auto') {
    return { allowed: true, reason: 'auto', manifestHash: hash };
  }

  const lease = await acquireMetadataTransactionLease(getDataDir());
  try {
    const existing = findWorkspaceManifestApproval(repoPath, hash);
    if (existing?.status === 'approved') {
      return { allowed: true, reason: 'approved', manifestHash: hash };
    }
    if (existing?.status === 'rejected') {
      return { allowed: false, reason: 'rejected', manifestHash: hash };
    }
    if (!existing) createManifestApproval(repoPath, hash, input.manifestSource);
    return { allowed: false, reason: 'awaiting_approval', manifestHash: hash };
  } finally {
    releaseMetadataTransactionLease(lease);
  }
}
