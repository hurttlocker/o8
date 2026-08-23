import { apiFetch, CliError, EXIT } from '../../api.js';
import { resolveConfig } from '../../config.js';
import { printHumanHeading, printJson, type OutputMode } from '../../output.js';
import { parsePacketArguments, resolvePacketTarget } from './target.js';

interface ScopeExpansionResponse {
  ok: boolean;
  packetId: string;
  laneId: string | null;
  requestedPaths: string[];
  allowedPaths: string[];
  reason: string;
  expanded: boolean;
}

export async function runPacketExpandScope(mode: OutputMode, rest: string[]): Promise<number> {
  const args = parsePacketArguments(rest, {
    command: 'expand-scope',
    valueFlags: ['paths', 'reason'],
  });
  const paths = (args.values.paths ?? '').split(',').map((path) => path.trim()).filter(Boolean);
  const reason = args.values.reason?.trim() ?? '';
  if (paths.length === 0 || !reason) {
    throw new CliError(
      'invalid_args',
      'o8 packet expand-scope requires --paths <path[,path]> and --reason <text>.',
      EXIT.INVALID_ARGS,
    );
  }
  const target = await resolvePacketTarget(args.target);
  const response = await apiFetch<ScopeExpansionResponse>(
    resolveConfig(),
    `/api/lanes/${encodeURIComponent(target.laneId)}/scope`,
    { method: 'POST', body: { paths, reason } },
  );
  if (!response.data) {
    throw new CliError('invalid_response', 'Server returned an empty scope expansion result.', EXIT.INVALID_ARGS);
  }
  if (mode.human) {
    printHumanHeading(response.data.expanded ? 'packet scope expanded' : 'packet scope unchanged');
    process.stdout.write(response.data.allowedPaths.map((path) => `  ${path}`).join('\n') + '\n');
  } else {
    printJson({ schema: 'o8/cli/packet.expand-scope/v1', ...response.data });
  }
  return 0;
}
