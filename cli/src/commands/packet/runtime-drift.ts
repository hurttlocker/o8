import { apiFetch, EXIT } from '../../api.js';
import { resolveConfig } from '../../config.js';
import { printJson, printHumanKv, printHumanHeading, type OutputMode } from '../../output.js';
import { parsePacketArguments, resolvePacketTarget } from './target.js';

export interface RuntimeDriftFields {
  laneId?: string | null;
  runtime?: string | null;
  actualRuntime?: string | null;
  worktreePath?: string | null;
}

export function warnRuntimeDriftIfNeeded(fields: RuntimeDriftFields, mode: OutputMode): void {
  const runtime = fields.runtime?.trim();
  const actualRuntime = fields.actualRuntime?.trim();
  if (!runtime || !actualRuntime || runtime === actualRuntime) return;

  const lane = fields.laneId ? ` lane ${fields.laneId}` : '';
  const worktree = fields.worktreePath ? ` in ${fields.worktreePath}` : '';
  const message = `runtime drift detected${lane}: declared ${runtime}, actual process is ${actualRuntime}${worktree}.`;

  if (mode.human) {
    process.stderr.write(`\nWARNING: ${message}\n`);
  } else {
    process.stderr.write(`warning: ${message}\n`);
  }
}

interface LaneScopeResponse {
  laneId: string;
  packetId: string | null;
  runtime: string;
  actualRuntime: string | null;
  worktreePath: string | null;
}

export async function runPacketRuntimeDrift(mode: OutputMode, rest: string[]): Promise<number> {
  const args = parsePacketArguments(rest, { command: 'runtime-drift' });
  const resolved = await resolvePacketTarget(args.target);

  const cfg = resolveConfig();
  const scope = await apiFetch<LaneScopeResponse>(
    cfg,
    `/api/lanes/${encodeURIComponent(resolved.laneId)}/scope`,
    { allowNotFound: true },
  );

  const data = scope.data;
  const declared = data?.runtime ?? null;
  const actual = data?.actualRuntime ?? null;
  const drift = Boolean(declared && actual && declared !== actual);

  const payload = {
    schema: 'o8/cli/packet.runtime-drift/v1',
    laneId: resolved.laneId,
    packetId: resolved.packetId,
    declaredRuntime: declared,
    actualRuntime: actual,
    drift,
    worktreePath: data?.worktreePath ?? resolved.worktreePath,
  };

  if (mode.human) {
    printHumanHeading('packet runtime-drift');
    printHumanKv([
      ['lane', resolved.laneId],
      ['packet', resolved.packetId ?? '(none)'],
      ['declared', declared ?? '(unknown)'],
      ['actual', actual ?? '(pending)'],
      ['drift', drift ? 'YES' : 'no'],
    ]);
  } else {
    printJson(payload);
  }
  return drift ? EXIT.CONFLICT : EXIT.OK;
}
