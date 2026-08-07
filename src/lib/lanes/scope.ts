import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { getDataDir } from '@/lib/data-dir-migration';
import { readAllDirectiveTrailers } from '@/lib/cortex/directive-merges';
import { directiveAppliesToRepo, resolveActiveDirectiveProjectScope } from '@/lib/cortex/directives/filter';
import { parseDirectiveFile, type ParsedDirective } from '@/lib/cortex/directives/parse';
import { appendEvent, getLane, getLaneEvents, listLanes } from '@/lib/lane/registry';
import type { Lane, LaneRuntime, LaneStatus } from '@/lib/lane/types';
import { FILE_SIZE_BLOCK_THRESHOLD_LINES } from '@/lib/orchestrator/preservation-envelope';
import { currentMissionState } from '@/lib/orchestrator/operator-mission-service/shared';
import type { OrchestratorPacket, OrchestratorPacketStatus } from '@/lib/orchestrator/types';
import { buildProjectTaskBrief, getProjectContext, type ProjectContextRepo } from '@/lib/projects/context';
import { listProjectLocks, type ProjectLock } from '@/lib/projects/locks';
import { getRuntimeProcessForWorktree, type RuntimeProcessOwner } from '@/lib/runtime/registry';

const execFileAsync = promisify(execFile);
const PACKET_SCOPE_SCHEMA = 'o8/packet.scope/v1';
const BLOCKED_PATHS = ['dist/**', 'out/**', '.next/**'];
const RELATED_PACKET_STATUSES = new Set<OrchestratorPacketStatus>(['running', 'awaiting_review', 'blocked']);
const INACTIVE_LANE_STATUSES = new Set<LaneStatus>(['completed', 'archived', 'failed']);

export interface PacketScopeDirective {
  id: string;
  title: string;
  scope: string;
  repoName: string | null;
  priority: number | null;
  body: string;
  projects: string[];
  recentMerges: string[];
}

export interface RelatedPacketScope {
  packetId: string;
  laneId: string | null;
  title: string;
  status: OrchestratorPacketStatus;
  runtime: string;
  branch: string | null;
  worktreePath: string | null;
  overlappingPaths: string[];
}

export interface PacketScopeProjectRepo {
  id: string;
  name: string;
  localPath: string;
  role: string | null;
  isMain: boolean;
  isCurrent: boolean;
}

export interface PacketScopeProjectLock {
  laneId: string;
  packetId: string | null;
  label: string;
  repoName: string;
  repoPath: string;
  runtime: string;
  branch: string;
  status: LaneStatus;
  stale: boolean;
  isCurrentLane: boolean;
  lastHeartbeatAt: number | null;
  lastEventAt: string | null;
}

export interface PacketScopeProject {
  id: string;
  name: string;
  slug: string;
  runtimeProjectId: string;
  mainRepo: PacketScopeProjectRepo | null;
  currentRepo: PacketScopeProjectRepo | null;
  relatedRepos: PacketScopeProjectRepo[];
  instructions: string | null;
  taskBrief: string;
  locks: PacketScopeProjectLock[];
  files: {
    enabled: boolean;
    note: string;
  };
  definitionOfDone: string[];
  doNotTouch: string[];
}

export interface PacketScope {
  schema: typeof PACKET_SCOPE_SCHEMA;
  packetId: string | null;
  laneId: string;
  runtime: string;
  actualRuntime: LaneRuntime | null;
  branch: string;
  baseBranch: string;
  headSha: string | null;
  worktreePath: string | null;
  fileLineCeiling: number;
  allowedPaths: string[];
  blockedPaths: string[];
  directives: PacketScopeDirective[];
  relatedPackets: RelatedPacketScope[];
  project: PacketScopeProject;
}

export interface GetPacketScopeInput {
  packetId?: string;
  laneId?: string;
}

function normalizeId(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed || null;
}

function findLaneByPacketId(packetId: string): Lane | null {
  return listLanes().find((lane) => lane.packetId === packetId) ?? null;
}

function packetOverlapPaths(packet: OrchestratorPacket | null): string[] {
  if (!packet) return [];
  const paths = packet.allowedFiles && packet.allowedFiles.length > 0
    ? packet.allowedFiles
    : packet.predictedFiles ?? [];
  return [...new Set(paths.map((path) => path.trim()).filter(Boolean))];
}

function packetAllowedPaths(packet: OrchestratorPacket | null): string[] {
  if (!packet) return [];
  if (packet.allowedFiles && packet.allowedFiles.length > 0) {
    return [...new Set(packet.allowedFiles.map((path) => path.trim()).filter(Boolean))];
  }
  const inlineIssue = (packet.issue?.number ?? 0) >= 90001 && !packet.issue?.url;
  return inlineIssue ? ['**/*'] : packetOverlapPaths(packet);
}

function normalizePathPattern(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\/+/, '');
}

function patternOverlaps(left: string, right: string): boolean {
  const a = normalizePathPattern(left);
  const b = normalizePathPattern(right);
  if (a === b) return true;

  const aPrefix = a.endsWith('/**') ? a.slice(0, -2) : null;
  const bPrefix = b.endsWith('/**') ? b.slice(0, -2) : null;
  if (aPrefix && b.startsWith(aPrefix)) return true;
  if (bPrefix && a.startsWith(bPrefix)) return true;
  return false;
}

function overlappingPaths(left: string[], right: string[]): string[] {
  const overlaps = new Set<string>();
  for (const a of left) {
    for (const b of right) {
      if (patternOverlaps(a, b)) {
        overlaps.add(a);
        overlaps.add(b);
      }
    }
  }
  return [...overlaps].sort();
}

function toDirectiveSummary(parsed: ParsedDirective, recentMerges: string[]): PacketScopeDirective {
  return {
    id: parsed.id,
    title: parsed.title,
    scope: parsed.scope,
    repoName: parsed.repoName,
    priority: parsed.priority,
    body: parsed.body,
    projects: parsed.projects,
    recentMerges,
  };
}

async function readDirectivesForRepo(repoPath: string): Promise<PacketScopeDirective[]> {
  const directivesDir = join(getDataDir(), 'directives');
  if (!existsSync(directivesDir)) return [];

  const parsed: ParsedDirective[] = [];
  for (const name of readdirSync(directivesDir).filter((entry) => entry.endsWith('.md'))) {
    try {
      const raw = readFileSync(join(directivesDir, name), 'utf-8');
      const directive = parseDirectiveFile(raw, name.replace(/\.md$/, ''));
      if (directive) parsed.push(directive);
    } catch (error) {
      console.warn(`[packet-scope] Failed to read directive ${name}:`, error);
    }
  }

  const projectScope = await resolveActiveDirectiveProjectScope(repoPath);
  const trailerMap = readAllDirectiveTrailers(3);
  return parsed
    .filter((directive) => directiveAppliesToRepo(directive, repoPath, projectScope))
    .map((directive) => toDirectiveSummary(directive, trailerMap[directive.id] ?? []))
    .sort((a, b) => {
      const ap = a.priority ?? 0;
      const bp = b.priority ?? 0;
      if (ap !== bp) return bp - ap;
      return a.title.localeCompare(b.title);
    });
}

async function readHeadSha(cwd: string): Promise<string | null> {
  // Full 40-char SHA. Worker agents diff this against the F42 HEAD-SHA
  // optimistic lock — short SHAs collide on busy repos.
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { windowsHide: true, cwd });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function recordRuntimeDriftOnce(
  lane: Lane,
  declaredRuntime: string,
  actualRuntime: LaneRuntime | null,
  processInfo: RuntimeProcessOwner | null,
) {
  if (!actualRuntime || declaredRuntime === actualRuntime) return;
  const alreadyLogged = getLaneEvents(lane.id, 1000).some((event) => event.verb === 'runtime_drift');
  if (alreadyLogged) return;

  appendEvent(lane.id, 'runtime_drift', 'system', {
    declaredRuntime,
    actualRuntime,
    worktreePath: lane.worktreePath ?? lane.repoPath,
    pid: processInfo?.pid ?? null,
    binaryPath: processInfo?.binaryPath ?? null,
  });
}

function relatedPacketsFor(
  targetPacketId: string | null,
  targetPaths: string[],
  packets: OrchestratorPacket[],
): RelatedPacketScope[] {
  if (!targetPacketId || targetPaths.length === 0) return [];
  const lanesByPacket = new Map(listLanes().flatMap((lane) => lane.packetId ? [[lane.packetId, lane] as const] : []));

  return packets.flatMap((packet) => {
    if (packet.id === targetPacketId) return [];
    if (!RELATED_PACKET_STATUSES.has(packet.status)) return [];
    const lane = lanesByPacket.get(packet.id) ?? null;
    if (!lane || INACTIVE_LANE_STATUSES.has(lane.status)) return [];

    const overlaps = overlappingPaths(targetPaths, packetOverlapPaths(packet));
    if (overlaps.length === 0) return [];
    return [{
      packetId: packet.id,
      laneId: lane.id,
      title: packet.title,
      status: packet.status,
      runtime: lane.runtime,
      branch: lane.branch,
      worktreePath: lane.worktreePath,
      overlappingPaths: overlaps,
    }];
  });
}

function toProjectRepo(
  repo: ProjectContextRepo | null,
  primaryRepoId: string | null,
  currentRepoId: string | null,
): PacketScopeProjectRepo | null {
  if (!repo) return null;
  return {
    id: repo.id,
    name: repo.name,
    localPath: repo.localPath,
    role: repo.role,
    isMain: repo.id === primaryRepoId,
    isCurrent: repo.id === currentRepoId,
  };
}

function toProjectLock(lock: ProjectLock, currentLaneId: string): PacketScopeProjectLock {
  return {
    laneId: lock.laneId,
    packetId: lock.packetId,
    label: lock.label,
    repoName: lock.repoName,
    repoPath: lock.repoPath,
    runtime: lock.runtime,
    branch: lock.branch,
    status: lock.status,
    stale: lock.stale,
    isCurrentLane: lock.laneId === currentLaneId,
    lastHeartbeatAt: lock.lastHeartbeatAt,
    lastEventAt: lock.lastEventAt,
  };
}

export async function getPacketScope(input: GetPacketScopeInput): Promise<PacketScope | null> {
  const packetIdInput = normalizeId(input.packetId);
  const laneIdInput = normalizeId(input.laneId);
  const lane = laneIdInput ? getLane(laneIdInput) : packetIdInput ? findLaneByPacketId(packetIdInput) : null;
  if (!lane) return null;

  const mission = currentMissionState();
  const packetId = packetIdInput ?? lane.packetId;
  const packet = packetId ? mission.packets.find((candidate) => candidate.id === packetId) ?? null : null;
  const repoPath = lane.worktreePath || lane.repoPath;
  const allowedPaths = packetAllowedPaths(packet);
  const overlapPaths = packetOverlapPaths(packet);
  const [directives, headSha, runtimeProcess] = await Promise.all([
    readDirectivesForRepo(lane.repoPath),
    readHeadSha(repoPath),
    getRuntimeProcessForWorktree(repoPath),
  ]);
  const declaredRuntime = packet?.runtime ?? lane.runtime;
  const actualRuntime = runtimeProcess?.runtime ?? null;
  const projectContext = await getProjectContext({
    repoPath: lane.repoPath,
    projectId: lane.projectId,
  });
  const projectBrief = buildProjectTaskBrief(projectContext, {
    repoPath: lane.repoPath,
    taskTitle: packet?.title ?? lane.label,
    taskBody: packet?.summary ?? null,
  });
  const projectLocks = await listProjectLocks(projectContext.id);
  const primaryRepoId = projectContext.primaryRepo?.id ?? null;
  const currentRepoId = projectContext.currentRepo?.id ?? null;
  const relatedRepos = projectContext.repos
    .filter((repo) => repo.id !== primaryRepoId && repo.id !== currentRepoId)
    .map((repo) => toProjectRepo(repo, primaryRepoId, currentRepoId))
    .filter((repo): repo is PacketScopeProjectRepo => Boolean(repo));

  recordRuntimeDriftOnce(lane, declaredRuntime, actualRuntime, runtimeProcess);

  return {
    schema: PACKET_SCOPE_SCHEMA,
    packetId,
    laneId: lane.id,
    runtime: declaredRuntime,
    actualRuntime,
    branch: lane.branch,
    baseBranch: lane.baseBranch,
    headSha,
    worktreePath: lane.worktreePath,
    fileLineCeiling: FILE_SIZE_BLOCK_THRESHOLD_LINES,
    allowedPaths,
    blockedPaths: BLOCKED_PATHS,
    directives,
    relatedPackets: relatedPacketsFor(packetId, overlapPaths, mission.packets),
    project: {
      id: projectContext.id,
      name: projectContext.name,
      slug: projectContext.slug,
      runtimeProjectId: projectContext.runtimeProjectId,
      mainRepo: toProjectRepo(projectContext.primaryRepo, primaryRepoId, currentRepoId),
      currentRepo: toProjectRepo(projectContext.currentRepo, primaryRepoId, currentRepoId),
      relatedRepos,
      instructions: projectContext.instructions,
      taskBrief: projectBrief,
      locks: projectLocks.map((lock) => toProjectLock(lock, lane.id)),
      files: {
        enabled: projectContext.files.enabled,
        note: projectContext.files.note,
      },
      definitionOfDone: [
        'Stay inside allowed paths unless the task explicitly requires a scoped expansion.',
        'Run targeted checks for the changed surface, or report why checks were not possible.',
        'Report changed repos, locks/conflicts, and review handoffs before completion.',
      ],
      doNotTouch: [
        ...BLOCKED_PATHS,
        'Sibling repos unless the task explicitly requires cross-repo edits.',
        'Unrelated user or agent changes already present in the worktree.',
      ],
    },
  };
}
