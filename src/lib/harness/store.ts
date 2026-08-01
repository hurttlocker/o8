import 'server-only';

import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { getSqlite } from '@/lib/db';
import type {
  HarnessCheckStatus,
  HarnessContract,
  HarnessContractStatus,
  HarnessFeature,
  HarnessFeatureCheck,
  HarnessFeatureStatus,
  HarnessGroundingArtifact,
  HarnessSprint,
  HarnessSprintEvent,
} from './types';

interface FeatureRow {
  id: string;
  repo_path: string;
  title: string;
  description: string;
  priority: number;
  status: HarnessFeatureStatus;
  verification_command_json: string | null;
  metadata_json: string;
  created_at: number;
  updated_at: number;
}

interface FeatureCheckRow {
  id: string;
  feature_id: string;
  status: HarnessCheckStatus;
  evidence: string;
  command_json: string | null;
  exit_code: number | null;
  model_id: string | null;
  packet_id: string | null;
  created_at: number;
}

interface GroundingRow {
  artifact_json: string;
}

interface ContractRow {
  id: string;
  repo_path: string;
  feature_id: string | null;
  grounding_id: string | null;
  generator_terms: string;
  evaluator_terms: string;
  acceptance_json: string;
  status: HarnessContractStatus;
  proposed_by: string | null;
  accepted_by: string | null;
  created_at: number;
  accepted_at: number | null;
  updated_at: number;
}

interface SprintRow {
  id: string;
  repo_path: string;
  contract_id: string;
  packet_id: string | null;
  current_feature_id: string | null;
  status: 'active' | 'blocked' | 'completed';
  tick_count: number;
  event_log_json: string;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function cleanText(value: string, field: string, maxLength: number): string {
  const text = value.trim();
  if (!text) throw new Error(`${field} is required`);
  if (text.length > maxLength) throw new Error(`${field} exceeds ${maxLength} characters`);
  return text;
}

function cleanCommand(command: string[] | null | undefined): string[] | null {
  if (!command?.length) return null;
  if (command.length > 32) throw new Error('verification command has too many arguments');
  return command.map((part) => cleanText(part, 'verification command argument', 2_000));
}

export function canonicalRepoPath(repoPath: string): string {
  const candidate = resolve(cleanText(repoPath, 'repoPath', 4_096));
  const canonical = realpathSync(candidate);
  if (!statSync(canonical).isDirectory()) throw new Error(`repoPath is not a directory: ${candidate}`);
  return canonical;
}

function rowToCheck(row: FeatureCheckRow): HarnessFeatureCheck {
  return {
    id: row.id,
    featureId: row.feature_id,
    status: row.status,
    evidence: row.evidence,
    command: parseJson<string[] | null>(row.command_json, null),
    exitCode: row.exit_code,
    modelId: row.model_id,
    packetId: row.packet_id,
    createdAt: row.created_at,
  };
}

function latestCheck(featureId: string): HarnessFeatureCheck | null {
  const row = getSqlite().prepare(`
    SELECT * FROM harness_feature_checks
     WHERE feature_id = ?
     ORDER BY created_at DESC, id DESC
     LIMIT 1
  `).get(featureId) as FeatureCheckRow | undefined;
  return row ? rowToCheck(row) : null;
}

function rowToFeature(row: FeatureRow): HarnessFeature {
  return {
    id: row.id,
    repoPath: row.repo_path,
    title: row.title,
    description: row.description,
    priority: row.priority,
    status: row.status,
    verificationCommand: parseJson<string[] | null>(row.verification_command_json, null),
    metadata: parseJson<Record<string, unknown>>(row.metadata_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    latestCheck: latestCheck(row.id),
  };
}

export function addFeature(input: {
  repoPath: string;
  title: string;
  description?: string;
  priority?: number;
  verificationCommand?: string[] | null;
  metadata?: Record<string, unknown>;
}): HarnessFeature {
  const repoPath = canonicalRepoPath(input.repoPath);
  const title = cleanText(input.title, 'title', 300);
  const description = (input.description ?? '').trim().slice(0, 10_000);
  const priority = Number.isInteger(input.priority) ? Math.max(0, Math.min(10_000, input.priority!)) : 100;
  const command = cleanCommand(input.verificationCommand);
  const now = Date.now();
  const id = `feature-${randomUUID()}`;
  getSqlite().prepare(`
    INSERT INTO harness_features (
      id, repo_path, title, description, priority, status,
      verification_command_json, metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'failing', ?, ?, ?, ?)
  `).run(
    id,
    repoPath,
    title,
    description,
    priority,
    command ? JSON.stringify(command) : null,
    JSON.stringify(input.metadata ?? {}),
    now,
    now,
  );
  return getFeature(id)!;
}

export function getFeature(id: string): HarnessFeature | null {
  const row = getSqlite().prepare('SELECT * FROM harness_features WHERE id = ?').get(id) as FeatureRow | undefined;
  return row ? rowToFeature(row) : null;
}

export function listFeatures(input: {
  repoPath: string;
  status?: HarnessFeatureStatus | null;
  limit?: number;
}): HarnessFeature[] {
  const repoPath = canonicalRepoPath(input.repoPath);
  const limit = Math.max(1, Math.min(500, input.limit ?? 200));
  const rows = input.status
    ? getSqlite().prepare(`
        SELECT * FROM harness_features
         WHERE repo_path = ? AND status = ?
         ORDER BY priority ASC, created_at ASC
         LIMIT ?
      `).all(repoPath, input.status, limit) as FeatureRow[]
    : getSqlite().prepare(`
        SELECT * FROM harness_features
         WHERE repo_path = ?
         ORDER BY CASE status WHEN 'failing' THEN 0 WHEN 'blocked' THEN 1 ELSE 2 END,
                  priority ASC, created_at ASC
         LIMIT ?
      `).all(repoPath, limit) as FeatureRow[];
  return rows.map(rowToFeature);
}

export function nextFeature(repoPath: string): HarnessFeature | null {
  return listFeatures({ repoPath, status: 'failing', limit: 1 })[0] ?? null;
}

export function setFeatureStatus(input: {
  featureId: string;
  status: HarnessFeatureStatus;
  repoPath?: string;
}): HarnessFeature {
  const feature = getFeature(input.featureId);
  if (!feature) throw new Error(`feature not found: ${input.featureId}`);
  if (input.repoPath && feature.repoPath !== canonicalRepoPath(input.repoPath)) {
    throw new Error('feature belongs to a different repository');
  }
  getSqlite().prepare('UPDATE harness_features SET status = ?, updated_at = ? WHERE id = ?')
    .run(input.status, Date.now(), input.featureId);
  return getFeature(input.featureId)!;
}

export function listFeatureChecks(featureId: string, limit = 100): HarnessFeatureCheck[] {
  const rows = getSqlite().prepare(`
    SELECT * FROM harness_feature_checks
     WHERE feature_id = ?
     ORDER BY created_at DESC, id DESC
     LIMIT ?
  `).all(featureId, Math.max(1, Math.min(500, limit))) as FeatureCheckRow[];
  return rows.map(rowToCheck);
}

export function recordFeatureCheck(input: {
  featureId: string;
  status: HarnessCheckStatus;
  evidence?: string;
  command?: string[] | null;
  exitCode?: number | null;
  modelId?: string | null;
  packetId?: string | null;
  repoPath?: string;
}): { feature: HarnessFeature; check: HarnessFeatureCheck } {
  const feature = getFeature(input.featureId);
  if (!feature) throw new Error(`feature not found: ${input.featureId}`);
  if (input.repoPath && feature.repoPath !== canonicalRepoPath(input.repoPath)) {
    throw new Error('feature belongs to a different repository');
  }
  const id = `check-${randomUUID()}`;
  const now = Date.now();
  const command = cleanCommand(input.command);
  getSqlite().transaction(() => {
    getSqlite().prepare(`
      INSERT INTO harness_feature_checks (
        id, feature_id, status, evidence, command_json, exit_code, model_id, packet_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      feature.id,
      input.status,
      (input.evidence ?? '').trim().slice(0, 50_000),
      command ? JSON.stringify(command) : null,
      Number.isInteger(input.exitCode) ? input.exitCode : null,
      input.modelId?.trim().slice(0, 200) || null,
      input.packetId?.trim().slice(0, 200) || null,
      now,
    );
    if (input.status !== 'skipped') {
      const status: HarnessFeatureStatus = input.status === 'passed' ? 'passing' : 'failing';
      getSqlite().prepare('UPDATE harness_features SET status = ?, updated_at = ? WHERE id = ?')
        .run(status, now, feature.id);
    }
  })();
  return { feature: getFeature(feature.id)!, check: latestCheck(feature.id)! };
}

export function saveGrounding(artifact: HarnessGroundingArtifact): HarnessGroundingArtifact {
  const repoPath = canonicalRepoPath(artifact.repoPath);
  if (repoPath !== artifact.repoPath) artifact = { ...artifact, repoPath };
  getSqlite().prepare(`
    INSERT INTO harness_groundings (id, repo_path, task, feature_id, packet_id, artifact_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    artifact.id,
    repoPath,
    artifact.task,
    artifact.featureId,
    artifact.packetId,
    JSON.stringify(artifact),
    artifact.createdAt,
  );
  return artifact;
}

export function getGrounding(id: string): HarnessGroundingArtifact | null {
  const row = getSqlite().prepare('SELECT artifact_json FROM harness_groundings WHERE id = ?')
    .get(id) as GroundingRow | undefined;
  return row ? parseJson<HarnessGroundingArtifact | null>(row.artifact_json, null) : null;
}

export function listGroundings(repoPath: string, limit = 20): HarnessGroundingArtifact[] {
  const canonical = canonicalRepoPath(repoPath);
  const rows = getSqlite().prepare(`
    SELECT artifact_json FROM harness_groundings
     WHERE repo_path = ?
     ORDER BY created_at DESC
     LIMIT ?
  `).all(canonical, Math.max(1, Math.min(100, limit))) as GroundingRow[];
  return rows
    .map((row) => parseJson<HarnessGroundingArtifact | null>(row.artifact_json, null))
    .filter((row): row is HarnessGroundingArtifact => row !== null);
}

function rowToContract(row: ContractRow): HarnessContract {
  return {
    id: row.id,
    repoPath: row.repo_path,
    featureId: row.feature_id,
    groundingId: row.grounding_id,
    generatorTerms: row.generator_terms,
    evaluatorTerms: row.evaluator_terms,
    acceptanceCriteria: parseJson<string[]>(row.acceptance_json, []),
    status: row.status,
    proposedBy: row.proposed_by,
    acceptedBy: row.accepted_by,
    createdAt: row.created_at,
    acceptedAt: row.accepted_at,
    updatedAt: row.updated_at,
  };
}

export function getContract(id: string): HarnessContract | null {
  const row = getSqlite().prepare('SELECT * FROM harness_contracts WHERE id = ?').get(id) as ContractRow | undefined;
  return row ? rowToContract(row) : null;
}

export function listContracts(repoPath: string, limit = 50): HarnessContract[] {
  const rows = getSqlite().prepare(`
    SELECT * FROM harness_contracts
     WHERE repo_path = ?
     ORDER BY created_at DESC
     LIMIT ?
  `).all(canonicalRepoPath(repoPath), Math.max(1, Math.min(200, limit))) as ContractRow[];
  return rows.map(rowToContract);
}

export function proposeContract(input: {
  repoPath: string;
  featureId?: string | null;
  groundingId?: string | null;
  generatorTerms: string;
  evaluatorTerms: string;
  acceptanceCriteria: string[];
  proposedBy?: string | null;
}): HarnessContract {
  const repoPath = canonicalRepoPath(input.repoPath);
  if (input.featureId) {
    const feature = getFeature(input.featureId);
    if (!feature || feature.repoPath !== repoPath) throw new Error('feature not found in repository');
  }
  if (input.groundingId) {
    const grounding = getGrounding(input.groundingId);
    if (!grounding || grounding.repoPath !== repoPath) throw new Error('grounding not found in repository');
  }
  const acceptance = input.acceptanceCriteria
    .map((criterion) => cleanText(criterion, 'acceptance criterion', 2_000))
    .slice(0, 100);
  if (acceptance.length === 0) throw new Error('at least one acceptance criterion is required');
  const now = Date.now();
  const id = `contract-${randomUUID()}`;
  getSqlite().prepare(`
    INSERT INTO harness_contracts (
      id, repo_path, feature_id, grounding_id, generator_terms, evaluator_terms,
      acceptance_json, status, proposed_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?)
  `).run(
    id,
    repoPath,
    input.featureId ?? null,
    input.groundingId ?? null,
    cleanText(input.generatorTerms, 'generatorTerms', 20_000),
    cleanText(input.evaluatorTerms, 'evaluatorTerms', 20_000),
    JSON.stringify(acceptance),
    input.proposedBy?.trim().slice(0, 200) || null,
    now,
    now,
  );
  return getContract(id)!;
}

export function transitionContract(input: {
  contractId: string;
  status: Extract<HarnessContractStatus, 'accepted' | 'verified' | 'failed' | 'superseded'>;
  actor?: string | null;
}): HarnessContract {
  const contract = getContract(input.contractId);
  if (!contract) throw new Error(`contract not found: ${input.contractId}`);
  const allowed: Record<HarnessContractStatus, HarnessContractStatus[]> = {
    proposed: ['accepted', 'superseded'],
    accepted: ['verified', 'failed', 'superseded'],
    verified: ['superseded'],
    failed: ['superseded'],
    superseded: [],
  };
  if (!allowed[contract.status].includes(input.status)) {
    throw new Error(`invalid contract transition: ${contract.status} -> ${input.status}`);
  }
  const now = Date.now();
  getSqlite().prepare(`
    UPDATE harness_contracts
       SET status = ?, accepted_by = CASE WHEN ? = 'accepted' THEN ? ELSE accepted_by END,
           accepted_at = CASE WHEN ? = 'accepted' THEN ? ELSE accepted_at END,
           updated_at = ?
     WHERE id = ?
  `).run(input.status, input.status, input.actor?.trim().slice(0, 200) || 'operator', input.status, now, now, contract.id);
  return getContract(contract.id)!;
}

function rowToSprint(row: SprintRow): HarnessSprint {
  return {
    id: row.id,
    repoPath: row.repo_path,
    contractId: row.contract_id,
    packetId: row.packet_id,
    currentFeatureId: row.current_feature_id,
    status: row.status,
    tickCount: row.tick_count,
    events: parseJson<HarnessSprintEvent[]>(row.event_log_json, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

export function getSprint(id: string): HarnessSprint | null {
  const row = getSqlite().prepare('SELECT * FROM harness_sprints WHERE id = ?').get(id) as SprintRow | undefined;
  return row ? rowToSprint(row) : null;
}

export function listSprints(repoPath: string, limit = 50): HarnessSprint[] {
  const rows = getSqlite().prepare(`
    SELECT * FROM harness_sprints
     WHERE repo_path = ?
     ORDER BY updated_at DESC
     LIMIT ?
  `).all(canonicalRepoPath(repoPath), Math.max(1, Math.min(200, limit))) as SprintRow[];
  return rows.map(rowToSprint);
}

function eligibleFeatureForContract(contract: HarnessContract): HarnessFeature | null {
  if (contract.featureId) {
    const feature = getFeature(contract.featureId);
    return feature && feature.status !== 'passing' ? feature : null;
  }
  return nextFeature(contract.repoPath);
}

export function startSprint(contractId: string, packetId?: string | null): HarnessSprint {
  const contract = getContract(contractId);
  if (!contract) throw new Error(`contract not found: ${contractId}`);
  if (contract.status !== 'accepted') throw new Error('contract must be accepted before starting a sprint');
  const existing = getSqlite().prepare(`
    SELECT * FROM harness_sprints
     WHERE contract_id = ? AND status IN ('active', 'blocked')
     ORDER BY updated_at DESC LIMIT 1
  `).get(contract.id) as SprintRow | undefined;
  if (existing) return rowToSprint(existing);
  const feature = eligibleFeatureForContract(contract);
  const now = Date.now();
  const status = feature?.status === 'blocked' ? 'blocked' : feature ? 'active' : 'completed';
  const event: HarnessSprintEvent = {
    at: now,
    type: feature?.status === 'blocked' ? 'blocked' : feature ? 'started' : 'completed',
    featureId: feature?.id ?? null,
    note: feature?.status === 'blocked'
      ? 'The contract feature is blocked.'
      : feature
        ? 'Sprint started with the highest-priority failing feature.'
        : 'No failing feature remained.',
  };
  const id = `sprint-${randomUUID()}`;
  getSqlite().prepare(`
    INSERT INTO harness_sprints (
      id, repo_path, contract_id, packet_id, current_feature_id, status, tick_count,
      event_log_json, created_at, updated_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
  `).run(
    id,
    contract.repoPath,
    contract.id,
    packetId?.trim().slice(0, 200) || null,
    feature?.id ?? null,
    status,
    JSON.stringify([event]),
    now,
    now,
    feature ? null : now,
  );
  if (!feature) transitionContract({ contractId: contract.id, status: 'verified', actor: 'sprint' });
  return getSprint(id)!;
}

export function tickSprint(input: { sprintId: string; note?: string }): HarnessSprint {
  const sprint = getSprint(input.sprintId);
  if (!sprint) throw new Error(`sprint not found: ${input.sprintId}`);
  if (sprint.status === 'completed') return sprint;
  const current = sprint.currentFeatureId ? getFeature(sprint.currentFeatureId) : null;
  let status: HarnessSprint['status'] = sprint.status;
  let next: HarnessFeature | null = current;
  let type: HarnessSprintEvent['type'] = 'advanced';
  let note = input.note?.trim().slice(0, 2_000) || '';

  if (current?.status === 'failing') {
    status = 'active';
    type = 'verification';
    note ||= 'Current feature is still failing; sprint did not advance.';
  } else if (current?.status === 'blocked') {
    status = 'blocked';
    type = 'blocked';
    note ||= 'Current feature is blocked.';
  } else {
    const contract = getContract(sprint.contractId)!;
    next = eligibleFeatureForContract(contract);
    if (!next) {
      status = 'completed';
      type = 'completed';
      note ||= 'All contract features passed.';
    } else {
      status = 'active';
      type = 'advanced';
      note ||= `Advanced to ${next.id}.`;
    }
  }

  const now = Date.now();
  const events = [...sprint.events, { at: now, type, featureId: next?.id ?? null, note }].slice(-500);
  getSqlite().transaction(() => {
    getSqlite().prepare(`
      UPDATE harness_sprints
         SET current_feature_id = ?, status = ?, tick_count = tick_count + 1,
             event_log_json = ?, updated_at = ?, completed_at = ?
       WHERE id = ?
    `).run(next?.id ?? null, status, JSON.stringify(events), now, status === 'completed' ? now : null, sprint.id);
    if (status === 'completed') {
      const contract = getContract(sprint.contractId);
      if (contract?.status === 'accepted') {
        getSqlite().prepare(`UPDATE harness_contracts SET status = 'verified', updated_at = ? WHERE id = ?`)
          .run(now, contract.id);
      }
    }
  })();
  return getSprint(sprint.id)!;
}
