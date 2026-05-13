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

interface PacketScopeDirective {
  id: string;
  title: string;
  scope: string;
  repoName: string | null;
  priority: number | null;
  body: string;
  projects: string[];
  recentMerges: string[];
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
  directives: PacketScopeDirective[];
  relatedPackets: RelatedPacketScope[];
}

function parseScopeId(rest: string[]): string {
  const id = rest.find((entry) => entry && !entry.startsWith('-'))?.trim() ?? '';
  if (!id) {
    throw new CliError(
      'invalid_args',
      'o8 packet scope <id> requires a packet id or lane id.',
      EXIT.INVALID_ARGS,
      'Example: o8 packet scope pkt-abc',
    );
  }
  return id;
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

  printHumanHeading(`allowed paths (${scope.allowedPaths.length})`);
  process.stdout.write(scope.allowedPaths.length > 0
    ? scope.allowedPaths.map((path) => `  ${path}`).join('\n') + '\n'
    : '  (none)\n');

  printHumanHeading(`blocked paths (${scope.blockedPaths.length})`);
  process.stdout.write(scope.blockedPaths.map((path) => `  ${path}`).join('\n') + '\n');

  printHumanHeading(`directives (${scope.directives.length})`);
  if (scope.directives.length === 0) {
    process.stdout.write('  (none)\n');
  } else {
    for (const directive of scope.directives) {
      const priority = directive.priority === null ? '' : ` priority=${directive.priority}`;
      process.stdout.write(`  ${directive.title} [${directive.scope}]${priority}\n`);
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
  const id = parseScopeId(rest);
  const cfg = resolveConfig();
  const res = await apiFetch<PacketScope>(cfg, `/api/lanes/${encodeURIComponent(id)}/scope`);
  if (!res.data) {
    throw new CliError('invalid_response', 'Server returned an empty packet scope.', EXIT.INVALID_ARGS);
  }

  if (mode.human) {
    printHumanScope(res.data);
  } else {
    printJson(res.data);
  }
  return 0;
}
