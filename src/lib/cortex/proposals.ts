import 'server-only';

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { getDataDir } from '@/lib/data-dir-migration';

export type ObservationKind = 'regression' | 'pattern' | 'gotcha' | 'preference';
export type ObservationScope = 'packet' | 'repo' | 'global';

export interface ObservationProposalCandidate {
  source: 'observation';
  id: string;
  packetId: string;
  laneId: string | null;
  kind: ObservationKind;
  text: string;
  scope: ObservationScope;
  proposed_by: string;
  createdAt: string;
  draftDirective: string;
}

interface ObservationProposalLedger {
  version: 1;
  entries: ObservationProposalCandidate[];
}

const PROPOSALS_FILE = 'observation-proposals.json';
const MAX_TEXT_LENGTH = 4_000;
const MAX_ENTRIES = 200;
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,180}$/;
const OBSERVATION_KINDS = new Set<ObservationKind>(['regression', 'pattern', 'gotcha', 'preference']);
const OBSERVATION_SCOPES = new Set<ObservationScope>(['packet', 'repo', 'global']);

function proposalsFilePath(): string {
  return join(getDataDir(), PROPOSALS_FILE);
}

function readString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === 'string' ? value.trim() : '';
}

function readKind(value: string): ObservationKind {
  if (OBSERVATION_KINDS.has(value as ObservationKind)) return value as ObservationKind;
  throw new Error('kind must be one of regression, pattern, gotcha, preference.');
}

function readScope(value: string): ObservationScope {
  if (!value) return 'packet';
  if (OBSERVATION_SCOPES.has(value as ObservationScope)) return value as ObservationScope;
  throw new Error('scope must be one of packet, repo, global.');
}

function validId(value: string): boolean {
  return ID_PATTERN.test(value);
}

function buildProposalId(input: {
  packetId: string;
  laneId: string | null;
  kind: ObservationKind;
  text: string;
  scope: ObservationScope;
  proposed_by: string;
}): string {
  return createHash('sha1')
    .update([
      input.packetId,
      input.laneId ?? '',
      input.kind,
      input.scope,
      input.proposed_by,
      input.text,
    ].join('\0'), 'utf-8')
    .digest('hex')
    .slice(0, 16);
}

function provenanceLabel(proposal: Pick<ObservationProposalCandidate, 'proposed_by' | 'laneId'>): string {
  return proposal.laneId && proposal.laneId !== proposal.proposed_by
    ? `${proposal.proposed_by} / ${proposal.laneId}`
    : proposal.proposed_by;
}

function buildDraftDirective(proposal: Omit<ObservationProposalCandidate, 'draftDirective'>): string {
  return [
    `# ${proposal.kind} observation`,
    '',
    `Scope: ${proposal.scope}`,
    `Proposed by: ${provenanceLabel(proposal)}`,
    '',
    proposal.text,
  ].join('\n');
}

function coerceEntry(entry: unknown): ObservationProposalCandidate | null {
  if (!entry || typeof entry !== 'object') return null;
  const record = entry as Record<string, unknown>;
  if (record.source !== 'observation') return null;
  const packetId = readString(record, 'packetId');
  const proposedBy = readString(record, 'proposed_by');
  const kind = record.kind;
  const text = readString(record, 'text');
  const scope = record.scope;
  if (!packetId || !proposedBy || !text || !OBSERVATION_KINDS.has(kind as ObservationKind)) return null;
  if (!OBSERVATION_SCOPES.has(scope as ObservationScope)) return null;
  return {
    source: 'observation',
    id: readString(record, 'id') || buildProposalId({
      packetId,
      laneId: readString(record, 'laneId') || null,
      kind: kind as ObservationKind,
      text,
      scope: scope as ObservationScope,
      proposed_by: proposedBy,
    }),
    packetId,
    laneId: readString(record, 'laneId') || null,
    kind: kind as ObservationKind,
    text,
    scope: scope as ObservationScope,
    proposed_by: proposedBy,
    createdAt: readString(record, 'createdAt') || new Date(0).toISOString(),
    draftDirective: readString(record, 'draftDirective') || buildDraftDirective({
      source: 'observation',
      id: '',
      packetId,
      laneId: readString(record, 'laneId') || null,
      kind: kind as ObservationKind,
      text,
      scope: scope as ObservationScope,
      proposed_by: proposedBy,
      createdAt: '',
    }),
  };
}

function readLedger(): ObservationProposalLedger {
  const path = proposalsFilePath();
  if (!existsSync(path)) return { version: 1, entries: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<ObservationProposalLedger>;
    const entries = Array.isArray(parsed.entries)
      ? parsed.entries.map(coerceEntry).filter((entry): entry is ObservationProposalCandidate => !!entry)
      : [];
    return { version: 1, entries };
  } catch (err) {
    console.warn('[cortex-proposals] Failed to parse observation proposals:', err instanceof Error ? err.message : err);
    return { version: 1, entries: [] };
  }
}

function writeLedger(ledger: ObservationProposalLedger): void {
  const path = proposalsFilePath();
  mkdirSync(getDataDir(), { recursive: true });
  writeFileSync(path, JSON.stringify(ledger, null, 2), 'utf-8');
}

export function readObservationProposals(): ObservationProposalCandidate[] {
  return readLedger().entries
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, MAX_ENTRIES);
}

export function proposeObservation(input: unknown): ObservationProposalCandidate {
  const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const packetId = readString(record, 'packetId');
  const laneId = readString(record, 'laneId') || null;
  const proposedBy = readString(record, 'proposed_by') || packetId || laneId || '';
  const kind = readKind(readString(record, 'kind'));
  const scope = readScope(readString(record, 'scope'));
  const text = readString(record, 'text').slice(0, MAX_TEXT_LENGTH);

  if (!packetId) throw new Error('packetId is required.');
  if (!validId(packetId) || (laneId && !validId(laneId)) || !validId(proposedBy)) {
    throw new Error('packetId, laneId, and proposed_by may only contain letters, numbers, dot, underscore, colon, or hyphen.');
  }
  if (!text) throw new Error('text is required.');

  const base = {
    source: 'observation' as const,
    id: '',
    packetId,
    laneId,
    kind,
    text,
    scope,
    proposed_by: proposedBy,
    createdAt: new Date().toISOString(),
  };
  const proposal: ObservationProposalCandidate = {
    ...base,
    id: buildProposalId(base),
    draftDirective: buildDraftDirective(base),
  };

  const ledger = readLedger();
  const existingIdx = ledger.entries.findIndex((entry) => entry.id === proposal.id);
  if (existingIdx >= 0) {
    ledger.entries[existingIdx] = proposal;
  } else {
    ledger.entries.unshift(proposal);
  }
  ledger.entries = ledger.entries.slice(0, MAX_ENTRIES);
  writeLedger(ledger);
  return proposal;
}

export function dismissObservationProposal(id: string): boolean {
  const ledger = readLedger();
  const next = ledger.entries.filter((entry) => entry.id !== id);
  if (next.length === ledger.entries.length) return false;
  writeLedger({ version: 1, entries: next });
  return true;
}
