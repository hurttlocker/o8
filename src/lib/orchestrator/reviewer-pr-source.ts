import { execFile } from '@/lib/providers/child-process';
import { promisify } from 'node:util';
import { normalizeReviewerPrSource, type ReviewerPrSource } from '@/lib/orchestrator/reviewer-pr-source-types';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import type { PacketCreationBaseAuthority } from '@/lib/lane/packet-creation-base';

const execFileAsync = promisify(execFile);
export class ReviewerPrInputError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

export function validateReviewPullRequest(body: Record<string, unknown>): number | undefined {
  if (body.reviewPullRequest === undefined) return undefined;
  const number = body.reviewPullRequest;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) {
    throw new ReviewerPrInputError('invalid_review_pull_request', 'reviewPullRequest must be a positive integer.');
  }
  if (body.readOnly !== true || body.checkoutMode === 'shared' || body.isolate === false) {
    throw new ReviewerPrInputError('invalid_review_mode', 'A PR review requires readOnly: true and an isolated checkout.');
  }
  return number;
}

/** Fetch on the host before the read-only worker starts. Keep a packet-specific GC root. */
export async function resolveReviewerPrSource(input: {
  repoPath: string; packetId: string; pullRequest: number; existing?: ReviewerPrSource;
}): Promise<ReviewerPrSource> {
  if (!/^pkt-delegate-[a-f0-9]{16}$/.test(input.packetId)) throw new Error('Invalid reviewer packet identity.');
  try {
    if (input.existing) {
      const source = normalizeReviewerPrSource(input.existing);
      if (!source || source.pullRequest !== input.pullRequest) throw new Error('Reviewer source changed.');
      await execFileAsync('git', ['cat-file', '-e', `${source.headSha}^{commit}`], { cwd: input.repoPath, timeout: 5_000 });
      return source;
    }
    const ref = `refs/o8/review-inputs/${input.packetId}`;
    await execFileAsync('git', ['fetch', '--no-tags', '--no-write-fetch-head', 'origin',
      `refs/pull/${input.pullRequest}/head:${ref}`], { cwd: input.repoPath, timeout: 30_000 });
    const { stdout } = await execFileAsync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: input.repoPath, timeout: 5_000 });
    const source = normalizeReviewerPrSource({ pullRequest: input.pullRequest, headSha: stdout.trim() });
    if (!source) throw new Error('Invalid PR head.');
    return source;
  } catch {
    // Git errors can contain credential-bearing remote URLs. Keep the public error bounded.
    throw new ReviewerPrSourceError('The requested PR head could not be fetched or its pinned commit is unavailable. No reviewer was launched.');
  }
}
export class ReviewerPrSourceError extends Error {}

export function reviewerCreationBase(input: {
  repoPath: string; packetId: string; branch: string; baseBranch: string; source: ReviewerPrSource;
}): PacketCreationBaseAuthority {
  return { repoPath: input.repoPath, packetId: input.packetId, branch: input.branch,
    baseBranch: input.baseBranch, baseCommit: input.source.headSha };
}

/** Relaunches must also refuse a reused workspace that no longer matches the reviewed PR. */
export async function assertReviewerPrCheckout(packetId: string | undefined, cwd: string): Promise<void> {
  if (!packetId) return;
  const { readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
  let packet: OrchestratorPacket | undefined = readOrchestratorControlPlaneState().packets.find(p => p.id === packetId);
  if (!packet) {
    const { listMissionRegistryEntries } = await import('@/lib/orchestrator/mission-registry');
    packet = listMissionRegistryEntries({ includeArchived: true }).flatMap(entry => entry.mission.packets).find(p => p.id === packetId);
  }
  if (!packet?.reviewSource) return;
  const source = normalizeReviewerPrSource(packet.reviewSource);
  const { stdout } = await execFileAsync('git', ['rev-parse', '--verify', 'HEAD'], { cwd, timeout: 5_000 });
  if (!source || packet.launchContext?.workMode !== 'read-only' || stdout.trim() !== source.headSha) {
    throw new ReviewerPrSourceError('Reviewer checkout does not match its pinned PR head. No reviewer was launched.');
  }
}
