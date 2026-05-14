/**
 * `o8 lane touches` — report active lanes touching one or more files.
 */

import { apiFetch } from '../api.js';
import { CliError, EXIT } from '../api.js';
import { resolveConfig } from '../config.js';
import {
  printHumanHeading,
  printJson,
  type OutputMode,
} from '../output.js';

interface LaneTouch {
  packetId: string | null;
  laneId: string;
  status: string;
  branch: string;
  lastTouchedAt: number;
  files: string[];
}

interface LaneTouchesResponse {
  schema: 'o8/lane.touches/v1';
  paths: string[];
  packetId?: string;
  laneId?: string;
  lanes: LaneTouch[];
}

interface LaneTouchesArgs {
  paths: string[];
  packet: string | null;
  repo: string | null;
}

function splitPathList(value: string) {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseLaneTouchesArgs(rest: string[]): LaneTouchesArgs {
  const paths: string[] = [];
  let packet: string | null = null;
  let repo: string | null = null;

  for (let i = 0; i < rest.length; i += 1) {
    const tok = rest[i];
    if (tok === '--path') {
      const value = rest[++i];
      if (!value) throw new CliError('invalid_args', '--path requires a value.', EXIT.INVALID_ARGS);
      paths.push(...splitPathList(value));
    } else if (tok.startsWith('--path=')) {
      paths.push(...splitPathList(tok.slice('--path='.length)));
    } else if (tok === '--packet') {
      packet = rest[++i] ?? null;
    } else if (tok.startsWith('--packet=')) {
      packet = tok.slice('--packet='.length);
    } else if (tok === '--repo') {
      repo = rest[++i] ?? null;
    } else if (tok.startsWith('--repo=')) {
      repo = tok.slice('--repo='.length);
    } else {
      throw new CliError(
        'invalid_args',
        `Unknown lane touches argument: ${tok}`,
        EXIT.INVALID_ARGS,
        'Usage: o8 lane touches --path <path>[,<path>] [--packet <id>] [--repo <slug>]',
      );
    }
  }

  return {
    paths: Array.from(new Set(paths)),
    packet: packet?.trim() || null,
    repo: repo?.trim() || null,
  };
}

export async function runLaneTouches(mode: OutputMode, rest: string[]): Promise<number> {
  const args = parseLaneTouchesArgs(rest);
  if (args.paths.length === 0 && !args.packet) {
    throw new CliError(
      'invalid_args',
      'o8 lane touches requires --path <path> or --packet <id>.',
      EXIT.INVALID_ARGS,
      'Examples: o8 lane touches --path src/lib/lane/registry.ts or o8 lane touches --packet pkt-abc',
    );
  }

  const cfg = resolveConfig();
  const res = await apiFetch<LaneTouchesResponse>(cfg, '/api/lanes/touches', {
    query: {
      path: args.paths.length > 0 ? args.paths.join(',') : undefined,
      packet: args.packet ?? undefined,
      repo: args.repo ?? undefined,
    },
  });
  const payload = res.data;
  if (!payload) {
    throw new CliError('invalid_response', 'Lane touches returned an empty response.', EXIT.INVALID_ARGS);
  }

  if (mode.human) {
    printHumanHeading(args.packet ? `lane touches for packet ${args.packet}` : 'lane touches');
    const lanes = payload.lanes ?? [];
    const paths = payload.paths?.length ? payload.paths.join(', ') : '';
    process.stdout.write(`paths: ${paths || '(none)'}\n`);
    process.stdout.write(`matches: ${lanes.length}\n`);
    for (const lane of lanes) {
      const id = lane.packetId ?? lane.laneId;
      const touchedAt = lane.lastTouchedAt ? new Date(lane.lastTouchedAt).toISOString() : '(unknown)';
      process.stdout.write(`  ${lane.status.padEnd(15)} ${id} ${lane.branch} ${touchedAt}\n`);
      if (lane.files.length > 0) {
        process.stdout.write(`    ${lane.files.join(', ')}\n`);
      }
    }
  } else {
    printJson(payload);
  }

  return 0;
}
