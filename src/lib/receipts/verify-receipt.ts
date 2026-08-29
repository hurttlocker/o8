import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import { canonicalJson } from './canonical';
import { parsePacketDisposition } from './disposition';
import {
  receiptKeyIdForPublicKey,
  verifyReceiptBytes,
} from './receipt-identity';
import {
  PACKET_RECEIPT_SCHEMA,
  type PacketReceipt,
  type PacketReceiptVerification,
} from './types';

const execFileAsync = promisify(execFile);

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function parsePacketReceipt(value: unknown): PacketReceipt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.schema !== PACKET_RECEIPT_SCHEMA
    || !nonEmptyString(record.receiptId)
    || !nonEmptyString(record.packetId)
    || typeof record.packetTitle !== 'string'
    || !nonEmptyString(record.laneId)
    || !record.repo
    || typeof record.repo !== 'object'
    || Array.isArray(record.repo)
    || !parsePacketDisposition(record.disposition)
    || !Array.isArray(record.reviews)
    || !Array.isArray(record.approvals)
    || !nonEmptyString(record.runtime)
    || (record.model !== null && typeof record.model !== 'string')
    || !nonEmptyString(record.createdAt)
    || !/^[a-f0-9]{16}$/.test(typeof record.keyId === 'string' ? record.keyId : '')
    || !nonEmptyString(record.signature)
  ) return null;

  const repo = record.repo as Record<string, unknown>;
  if (
    !nonEmptyString(repo.name)
    || !nonEmptyString(repo.baseBranch)
    || (repo.remote !== undefined && typeof repo.remote !== 'string')
  ) return null;

  const reviewsValid = record.reviews.every((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const review = entry as Record<string, unknown>;
    return nonEmptyString(review.turnId)
      && nonEmptyString(review.backend)
      && ['active', 'completed', 'failed', 'quota_discarded'].includes(String(review.outcome))
      && nonEmptyString(review.at);
  });
  const approvalsValid = record.approvals.every((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const approval = entry as Record<string, unknown>;
    return nonEmptyString(approval.id)
      && typeof approval.title === 'string'
      && nonEmptyString(approval.principal)
      && ['approved', 'rejected'].includes(String(approval.decision))
      && nonEmptyString(approval.at);
  });
  return reviewsValid && approvalsValid ? record as unknown as PacketReceipt : null;
}

async function gitRevParse(repoPath: string, revision: string): Promise<string | null> {
  try {
    const result = await execFileAsync(
      'git',
      ['-C', repoPath, 'rev-parse', '--verify', '--end-of-options', revision],
      { encoding: 'utf8', maxBuffer: 1024 * 1024 },
    );
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

export function readGitTree(repoPath: string, commit: string): Promise<string | null> {
  return gitRevParse(repoPath, `${commit}^{tree}`);
}

function normalizedRemoteHostPath(host: string, rawPath: string): string | null {
  const segments = rawPath
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter(Boolean);
  if (!host || segments.length < 2) return null;
  const owner = segments.at(-2)!;
  const name = segments.at(-1)!.replace(/\.git$/i, '');
  return owner && name ? `${host.toLowerCase()}/${owner}/${name}` : null;
}

export function normalizeGitRemote(remote: string): string | null {
  const trimmed = remote.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol === 'file:') return null;
    const normalized = normalizedRemoteHostPath(url.hostname, url.pathname);
    if (normalized) return normalized;
  } catch {
    // Fall through to the SCP-style syntax used by Git SSH remotes.
  }
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/.exec(trimmed);
  return scp ? normalizedRemoteHostPath(scp[1]!, scp[2]!) : null;
}

export async function readGitRemote(repoPath: string): Promise<string | null> {
  try {
    const result = await execFileAsync(
      'git',
      ['-C', repoPath, 'remote', 'get-url', 'origin'],
      { encoding: 'utf8', maxBuffer: 1024 * 1024 },
    );
    return normalizeGitRemote(result.stdout);
  } catch {
    return null;
  }
}

function emptyVerdict(errors: string[]): PacketReceiptVerification {
  return {
    ok: false,
    schema: null,
    receiptId: null,
    packetId: null,
    keyId: null,
    signatureValid: false,
    keyIdMatches: false,
    repository: {
      checked: false,
      repoPath: null,
      commitExists: null,
      treeMatches: null,
      actualTree: null,
    },
    errors,
  };
}

export async function verifyPacketReceipt(input: {
  receipt: unknown;
  publicKeyB64: string;
  repoPath?: string | null;
}): Promise<PacketReceiptVerification> {
  const receipt = parsePacketReceipt(input.receipt);
  if (!receipt) return emptyVerdict(['Receipt does not match the o8/packet-receipt/v1 contract.']);

  const errors: string[] = [];
  let keyIdMatches = false;
  try {
    keyIdMatches = receiptKeyIdForPublicKey(input.publicKeyB64) === receipt.keyId;
  } catch {
    errors.push('The supplied public key is not a valid Ed25519 public key.');
  }
  if (!keyIdMatches && errors.length === 0) {
    errors.push(`The supplied public key does not match receipt keyId ${receipt.keyId}.`);
  }

  const { signature, ...unsigned } = receipt;
  const signatureValid = keyIdMatches && verifyReceiptBytes(
    new TextEncoder().encode(canonicalJson(unsigned)),
    signature,
    input.publicKeyB64,
  );
  if (keyIdMatches && !signatureValid) errors.push('The receipt signature is invalid.');

  const repoPath = input.repoPath?.trim() || null;
  const repository: PacketReceiptVerification['repository'] = {
    checked: false,
    repoPath,
    commitExists: null,
    treeMatches: null,
    actualTree: null,
  };

  if (repoPath && receipt.disposition.kind === 'merged') {
    repository.checked = true;
    const commit = await gitRevParse(repoPath, `${receipt.disposition.mergeCommit}^{commit}`);
    repository.commitExists = commit !== null;
    if (!repository.commitExists) {
      repository.treeMatches = false;
      errors.push(`Merge commit ${receipt.disposition.mergeCommit} does not exist in ${repoPath}.`);
    } else {
      repository.actualTree = await readGitTree(repoPath, receipt.disposition.mergeCommit);
      repository.treeMatches = repository.actualTree === receipt.disposition.tree;
      if (!repository.treeMatches) {
        errors.push(`Merge commit tree does not match recorded tree ${receipt.disposition.tree}.`);
      }
    }
  }

  return {
    ok: errors.length === 0,
    schema: receipt.schema,
    receiptId: receipt.receiptId,
    packetId: receipt.packetId,
    keyId: receipt.keyId,
    signatureValid,
    keyIdMatches,
    repository,
    errors,
  };
}

export async function verifyPacketReceiptFile(input: {
  receiptPath: string;
  publicKeyB64: string;
  repoPath?: string | null;
}): Promise<PacketReceiptVerification> {
  try {
    const raw = await readFile(input.receiptPath, 'utf8');
    return verifyPacketReceipt({
      receipt: JSON.parse(raw) as unknown,
      publicKeyB64: input.publicKeyB64,
      repoPath: input.repoPath,
    });
  } catch (error) {
    return emptyVerdict([
      error instanceof Error ? `Unable to read receipt: ${error.message}` : 'Unable to read receipt.',
    ]);
  }
}
