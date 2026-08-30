/**
 * `o8 packet scope <id>` — one-call worker context for a packet or lane.
 */

import { apiFetch, CliError, EXIT } from '../../api.js';
import { resolveConfig } from '../../config.js';
import {
  printHumanHeading,
  printHumanKv,
  printJson,
  type OutputMode,
} from '../../output.js';
import { warnRuntimeDriftIfNeeded } from './runtime-drift.js';
import { parsePacketArguments, resolvePacketTarget } from './target.js';

interface PacketScopeDirective {
  id: string;
  title: string;
  scope?: string;
  repoName?: string | null;
  priority?: number | null;
  body?: string;
  projects?: string[];
  recentMerges?: string[];
}

interface RelatedPacketScope {
  packetId: string;
  laneId: string | null;
  title: string;
  status: string;
  runtime: string;
  branch: string | null;
  worktreePath: string | null;
  overlappingPaths: string[];
}

interface PacketScopeProjectRepo {
  id: string;
  name: string;
  localPath: string;
  role: string | null;
  isMain: boolean;
  isCurrent: boolean;
}

interface PacketScopeProjectLock {
  laneId: string;
  packetId: string | null;
  label: string;
  repoName: string;
  repoPath: string;
  runtime: string;
  branch: string;
  status: string;
  stale: boolean;
  isCurrentLane: boolean;
  lastHeartbeatAt: number | null;
  lastEventAt: string | null;
}

interface PacketScopeProject {
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

interface PacketScope {
  schema: 'o8/packet.scope/v1';
  packetId: string | null;
  laneId: string;
  runtime: string;
  actualRuntime: string | null;
  branch: string;
  baseBranch: string;
  headSha: string | null;
  worktreePath: string | null;
  fileLineCeiling: number;
  allowedPaths: string[];
  blockedPaths: string[];
  directiveCount: number;
  directives: PacketScopeDirective[];
  relatedPackets: RelatedPacketScope[];
  project?: PacketScopeProject;
}

async function resolveScopeInput(rest: string[]): Promise<{ id: string; includeDirectives: boolean }> {
  const args = parsePacketArguments(rest, {
    command: 'scope',
    booleanFlags: ['include-directives'],
  });
  return {
    id: (await resolvePacketTarget(args.target)).laneId,
    includeDirectives: args.booleans.has('include-directives'),
  };
}

function printHumanScope(scope: PacketScope): void {
  printHumanHeading('packet scope');
  printHumanKv([
    ['packet', scope.packetId ?? '(none)'],
    ['lane', scope.laneId],
    ['runtime', scope.runtime],
    ['actual runtime', scope.actualRuntime ?? '(pending)'],
    ['branch', scope.branch],
    ['base', scope.baseBranch],
    ['head', scope.headSha ?? '(unknown)'],
    ['worktree', scope.worktreePath ?? '(none)'],
    ['file ceiling', `${scope.fileLineCeiling} lines`],
  ]);

  if (scope.project) {
    const project = scope.project;
    const related = project.relatedRepos.map((repo) => (
      repo.role ? `${repo.name} (${repo.role})` : repo.name
    )).join(', ');
    const locks = project.locks.length === 0
      ? 'none'
      : `${project.locks.length} active${project.locks.some((lock) => lock.stale) ? ' (stale present)' : ''}`;

    printHumanHeading('project');
    printHumanKv([
      ['name', project.name],
      ['main repo', project.mainRepo ? `${project.mainRepo.name} — ${project.mainRepo.localPath}` : '(none)'],
      ['current repo', project.currentRepo ? `${project.currentRepo.name} — ${project.currentRepo.localPath}` : '(none)'],
      ['related repos', related || '(none)'],
      ['locks', locks],
      ['files', project.files.enabled ? 'enabled' : project.files.note],
    ]);

    if (project.instructions) {
      process.stdout.write(`  instructions: ${project.instructions}\n`);
    }

    printHumanHeading('task brief');
    process.stdout.write(project.taskBrief.split('\n').map((line) => `  ${line}`).join('\n') + '\n');

    printHumanHeading(`project locks (${project.locks.length})`);
    if (project.locks.length === 0) {
      process.stdout.write('  (none)\n');
    } else {
      for (const lock of project.locks) {
        const stale = lock.stale ? ' stale' : '';
        const current = lock.isCurrentLane ? ' current' : '';
        process.stdout.write(`  ${lock.repoName} ${lock.branch} ${lock.status}${stale}${current}\n`);
        process.stdout.write(`    lane=${lock.laneId} packet=${lock.packetId ?? '(none)'} runtime=${lock.runtime}\n`);
      }
    }
  }

  printHumanHeading(`allowed paths (${scope.allowedPaths.length})`);
  process.stdout.write(scope.allowedPaths.length > 0
    ? scope.allowedPaths.map((path) => `  ${path}`).join('\n') + '\n'
    : '  (none)\n');

  printHumanHeading(`blocked paths (${scope.blockedPaths.length})`);
  process.stdout.write(scope.blockedPaths.map((path) => `  ${path}`).join('\n') + '\n');

  printHumanHeading(`directives (${scope.directiveCount})`);
  if (scope.directives.length === 0) {
    process.stdout.write('  (none)\n');
  } else {
    for (const directive of scope.directives) {
      const scopeLabel = directive.scope ? ` [${directive.scope}]` : '';
      const priority = directive.priority === undefined || directive.priority === null ? '' : ` priority=${directive.priority}`;
      process.stdout.write(`  ${directive.title}${scopeLabel}${priority}\n`);
    }
  }

  printHumanHeading(`related packets (${scope.relatedPackets.length})`);
  if (scope.relatedPackets.length === 0) {
    process.stdout.write('  (none)\n');
  } else {
    for (const packet of scope.relatedPackets) {
      process.stdout.write(`  ${packet.packetId} ${packet.status} ${packet.branch ?? '(no branch)'}\n`);
      process.stdout.write(`    overlaps: ${packet.overlappingPaths.join(', ')}\n`);
    }
  }
}

export async function runPacketScope(mode: OutputMode, rest: string[]): Promise<number> {
  const { id, includeDirectives } = await resolveScopeInput(rest);
  const cfg = resolveConfig();
  const query = includeDirectives ? '?includeDirectives=true' : '';
  const res = await apiFetch<PacketScope>(cfg, `/api/lanes/${encodeURIComponent(id)}/scope${query}`);
  if (!res.data) {
    throw new CliError('invalid_response', 'Server returned an empty packet scope.', EXIT.INVALID_ARGS);
  }

  warnRuntimeDriftIfNeeded(res.data, mode);
  if (mode.human) {
    printHumanScope(res.data);
  } else {
    printJson(res.data);
  }
  return 0;
}
