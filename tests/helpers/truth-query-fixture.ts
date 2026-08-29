import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';
import type { PacketReceipt, UnsignedPacketReceipt } from '@/lib/receipts/types';

let truthFixtureSequence = 0;

function truthPacketFixture(overrides: Partial<OrchestratorPacket> = {}): OrchestratorPacket {
  return {
    id: 'pkt-truth-authz',
    referenceLabel: 'PKT-TRUTH',
    title: 'truth authz packet',
    summary: 'truth authz test packet',
    workspaceTargetPath: null,
    branchTarget: 'issue/truth-authz',
    runtime: 'codex',
    dependencyLabels: [],
    dependencyPacketIds: [],
    queueState: 'queued',
    releaseState: 'pending',
    status: 'running',
    blockedReason: null,
    lastEventAt: null,
    lastEventLabel: null,
    archivedAt: null,
    review: null,
    lane: null,
    orchestratorThreadId: null,
    ...overrides,
  };
}

async function fixtureDependencies() {
  const { createLane } = await import('@/lib/lane/registry');
  const { recordMission } = await import('@/lib/db/missions-store');
  const {
    artifactAbsPath,
    artifactRelPath,
    ensureArtifactBucket,
    recordArtifact,
  } = await import('@/lib/artifacts/store');
  const { canonicalJson } = await import('@/lib/receipts/canonical');
  const {
    getReceiptIdentity,
    signReceiptBytes,
    verifyReceiptBytes,
  } = await import('@/lib/receipts/receipt-identity');
  const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
  return {
    artifactAbsPath,
    artifactRelPath,
    canonicalJson,
    createEmptyOrchestratorMissionState,
    createLane,
    ensureArtifactBucket,
    getReceiptIdentity,
    recordArtifact,
    recordMission,
    signReceiptBytes,
    verifyReceiptBytes,
  };
}

export interface PersistedTruthPacket {
  packet: OrchestratorPacket;
  receiptPath: string;
}

async function persistTruthPacket(input: {
  packet: OrchestratorPacket;
  repoPath: string;
  repoName: string;
  remote: string;
}): Promise<PersistedTruthPacket> {
  const dependencies = await fixtureDependencies();
  const identity = dependencies.getReceiptIdentity();
  const lane = dependencies.createLane({
    label: input.packet.title,
    repoPath: input.repoPath,
    branch: `inline/${input.packet.id}`,
    baseBranch: 'main',
    runtime: 'codex',
    packetId: input.packet.id,
  });
  const createdAt = new Date().toISOString();
  const receiptId = `receipt-${input.packet.id}`;
  const unsigned: UnsignedPacketReceipt = {
    schema: 'o8/packet-receipt/v1',
    receiptId,
    packetId: input.packet.id,
    packetTitle: input.packet.title,
    laneId: lane.id,
    repo: { name: input.repoName, remote: input.remote, baseBranch: 'main' },
    disposition: {
      kind: 'merged',
      mergeCommit: `merge-${input.packet.id}`,
      headSha: `head-${input.packet.id}`,
      tree: `tree-${input.packet.id}`,
      evidenceKind: 'merge_command',
      releasedAt: createdAt,
    },
    reviews: [{
      turnId: `review-${input.packet.id}`,
      backend: 'codex',
      outcome: 'completed',
      at: createdAt,
    }],
    approvals: [{
      id: `approval-${input.packet.id}`,
      title: 'Merge packet',
      principal: 'operator',
      decision: 'approved',
      at: createdAt,
    }],
    runtime: 'codex',
    model: 'truth-test-model',
    createdAt,
    keyId: identity.keyId,
  };
  const receipt: PacketReceipt = {
    ...unsigned,
    signature: dependencies.signReceiptBytes(
      new TextEncoder().encode(dependencies.canonicalJson(unsigned)),
      identity.secretKey,
    ),
  };
  dependencies.ensureArtifactBucket(input.packet.id);
  const relPath = dependencies.artifactRelPath(input.packet.id, receiptId, 'json');
  const receiptPath = dependencies.artifactAbsPath(relPath);
  const serialized = `${dependencies.canonicalJson(receipt)}\n`;
  writeFileSync(receiptPath, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  const artifact = dependencies.recordArtifact({
    id: receiptId,
    kind: 'receipt',
    source: 'review-boundary',
    relPath,
    laneId: lane.id,
    packetId: input.packet.id,
    repoPath: input.repoPath,
    label: 'Signed packet receipt',
    mimeType: 'application/json',
    bytes: Buffer.byteLength(serialized),
  });
  if (!artifact) throw new Error(`Unable to persist truth fixture receipt ${receiptId}.`);

  const state: OrchestratorMissionState = {
    ...dependencies.createEmptyOrchestratorMissionState(),
    missionId: `mission-${input.packet.id}`,
    repoPath: input.repoPath,
    runtime: 'codex',
    packets: [input.packet],
    updatedAt: new Date().toISOString(),
  };
  dependencies.recordMission({
    id: state.missionId!,
    repoPath: input.repoPath,
    runtime: 'codex',
    prompt: input.packet.title,
    summary: input.packet.summary,
    constraints: '',
    packetMeta: [{
      id: input.packet.id,
      title: input.packet.title,
      referenceLabel: input.packet.referenceLabel,
    }],
    missionState: state,
    totalWaves: 1,
  });
  return { packet: input.packet, receiptPath };
}

export async function createTruthFixture() {
  truthFixtureSequence += 1;
  const suffix = `${Date.now()}-${truthFixtureSequence}`;
  const repoAPath = path.join(os.tmpdir(), `o8-truth-repo-a-${suffix}`);
  const repoBPath = path.join(os.tmpdir(), `o8-truth-repo-b-${suffix}`);
  const issueA = 91_000 + truthFixtureSequence * 2;
  const issueB = issueA + 1;
  const packetA = truthPacketFixture({
    id: `packet-truth-a-${suffix}`,
    referenceLabel: `#${issueA}`,
    title: `Truth repo A ${suffix}`,
    workspaceTargetPath: repoAPath,
    issue: { number: issueA, url: `https://example.test/team/repo-a/issues/${issueA}` },
  });
  const packetB = truthPacketFixture({
    id: `packet-truth-b-${suffix}`,
    referenceLabel: `#${issueB}`,
    title: `Truth repo B ${suffix}`,
    workspaceTargetPath: repoBPath,
    issue: { number: issueB, url: `https://example.test/team/repo-b/issues/${issueB}` },
  });
  const storedA = await persistTruthPacket({
    packet: packetA,
    repoPath: repoAPath,
    repoName: 'repo-a',
    remote: 'example.test/team/repo-a',
  });
  await persistTruthPacket({
    packet: packetB,
    repoPath: repoBPath,
    repoName: 'repo-b',
    remote: 'example.test/team/repo-b',
  });
  const dependencies = await fixtureDependencies();
  const identity = dependencies.getReceiptIdentity();
  return {
    packetA,
    packetB,
    issueA,
    issueB,
    receiptAPath: storedA.receiptPath,
    publicKey: identity.publicKeyB64,
    canonicalJson: dependencies.canonicalJson,
    verifyReceiptBytes: dependencies.verifyReceiptBytes,
  };
}

export async function createNameCollisionTruthFixture() {
  truthFixtureSequence += 1;
  const suffix = `${Date.now()}-${truthFixtureSequence}`;
  const registeredRepoPath = path.join(os.tmpdir(), `o8-truth-left-${suffix}`, 'repo');
  const otherRepoPath = path.join(os.tmpdir(), `o8-truth-right-${suffix}`, 'repo');
  const registered = await persistTruthPacket({
    packet: truthPacketFixture({
      id: `packet-truth-name-registered-${suffix}`,
      title: `Truth registered name ${suffix}`,
      workspaceTargetPath: registeredRepoPath,
    }),
    repoPath: registeredRepoPath,
    repoName: 'repo',
    remote: '',
  });
  const other = await persistTruthPacket({
    packet: truthPacketFixture({
      id: `packet-truth-name-other-${suffix}`,
      title: `Truth colliding name ${suffix}`,
      workspaceTargetPath: otherRepoPath,
    }),
    repoPath: otherRepoPath,
    repoName: 'repo',
    remote: '',
  });
  return { registered, other, registeredRepoPath, otherRepoPath };
}
