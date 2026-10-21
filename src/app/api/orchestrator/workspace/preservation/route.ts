import { NextRequest } from 'next/server';

import { resolveRequestPrincipal } from '@/lib/auth/principal';
import { bindIdempotencyClientMutation } from '@/lib/orchestrator/idempotency-store';
import { requirePanelAuth } from '@/lib/panel/auth';
import '@/lib/runtimes';
import { readWorkspaceGitBundle } from '@/lib/workspace/git-bundle-preservation';
import { inspectRetiredWorkspacePreservation, restoreWorkspacePreservation } from '@/lib/workspace/preservation-restorer';
import { resolvePacketRecoveryTarget } from '@/lib/workspace/recovery-target';
import { asRecord, operatorError, operatorSuccess, parseJsonBody } from '../../_utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function denied(request: NextRequest) {
  return requirePanelAuth(request) ?? (resolveRequestPrincipal(request) !== 'operator'
    ? operatorError('forbidden', 'Private workspace recovery is operator-only.', 403) : null);
}

export async function GET(request: NextRequest) {
  const refusal = denied(request);
  if (refusal) return refusal;
  const packetId = request.nextUrl.searchParams.get('packetId')?.trim() ?? '';
  const format = request.nextUrl.searchParams.get('format');
  if (!packetId || packetId.length > 256) return operatorError('invalid_request', 'packetId is required.', 400);
  if (format && format !== 'bundle') return operatorError('invalid_request', 'The preservation format is unsupported.', 400);
  try {
    const { repo } = await resolvePacketRecoveryTarget(packetId);
    const { receipt, payload } = await inspectRetiredWorkspacePreservation(repo.id, packetId);
    if (format === 'bundle') {
      if (!receipt.gitBundle) return operatorError('bundle_unavailable', 'This historical preservation has no portable Git bundle.', 409);
      const content = await readWorkspaceGitBundle(receipt.gitBundle);
      return new Response(new Uint8Array(content), { headers: {
        'content-type': 'application/octet-stream',
        'content-disposition': 'attachment; filename="' + receipt.gitBundle.sha256 + '.bundle"',
        'content-length': String(content.length), 'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
      } });
    }
    return operatorSuccess({
      schema: 'o8/workspace-preservation/v1', packetId,
      preservationId: receipt.preservationId, manifestSha256: receipt.manifestSha256,
      handoffSha256: receipt.handoffSha256, artifactCount: receipt.artifactCount, artifactBytes: receipt.artifactBytes,
      headCommit: receipt.headCommit, treeSha: receipt.treeSha,
      gitBundle: receipt.gitBundle ?? null,
      artifacts: payload.capture.entries.map(({ path, kind, bytes, sha256 }) => ({ path, kind, bytes, sha256 })),
    });
  } catch {
    return operatorError('preservation_unavailable', 'The retired workspace has no verified private recovery receipt.', 409);
  }
}

export async function POST(request: NextRequest) {
  const refusal = denied(request);
  if (refusal) return refusal;
  const record = asRecord(await parseJsonBody(request));
  const sourcePacketId = typeof record?.sourcePacketId === 'string' ? record.sourcePacketId.trim() : '';
  const targetPacketId = typeof record?.targetPacketId === 'string' ? record.targetPacketId.trim() : '';
  const clientMutationId = typeof record?.clientMutationId === 'string' ? record.clientMutationId.trim() : '';
  const paths = Array.isArray(record?.paths) ? record.paths : null;
  if (!sourcePacketId || sourcePacketId.length > 256 || !targetPacketId || targetPacketId.length > 256
    || !clientMutationId || clientMutationId.length > 200 || !paths?.length || paths.length > 100
    || paths.some((entry) => typeof entry !== 'string')) {
    return operatorError('invalid_request', 'Provide sourcePacketId, targetPacketId, paths and clientMutationId.', 400);
  }
  try {
    const body = JSON.stringify({ sourcePacketId, targetPacketId, paths: [...paths].sort() });
    const binding = bindIdempotencyClientMutation({ namespace: 'workspace_artifact_recovery', clientKey: clientMutationId, body });
    if (binding.status !== 'bound' && binding.status !== 'matched') {
      return operatorError('recovery_idempotency_refused', 'Recovery intent could not be bound to this mutation identifier.', 409);
    }
    return operatorSuccess(await restoreWorkspacePreservation({ sourcePacketId, targetPacketId, clientMutationId, paths }));
  } catch (error) {
    return operatorError('recovery_refused', error instanceof Error ? error.message : 'Private artifact recovery was refused.', 409);
  }
}
