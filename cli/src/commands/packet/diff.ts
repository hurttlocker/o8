/**
 * `o8 packet diff [id] [--max-bytes <n>]` — the packet's code diff (committed +
 * uncommitted) against where its lane diverged from base. Byte-bounded by the
 * server so it stays token-safe; auto-resolves the lane from cwd.
 */

import { apiFetch, CliError, EXIT } from '../../api.js';
import { resolveConfig } from '../../config.js';
import { printHumanHeading, printJson, type OutputMode } from '../../output.js';
import { parsePacketArguments, resolvePacketTarget } from './target.js';

interface PacketDiff {
  ok: boolean;
  laneId: string;
  packetId: string | null;
  base: string;
  branch: string;
  stat: string;
  diff: string;
  sizeBytes: number;
  truncated: boolean;
  maxBytes: number;
}

function parseDiffArgs(rest: string[]): { id: string | null; maxBytes: number | null } {
  const args = parsePacketArguments(rest, {
    command: 'diff',
    valueFlags: ['max-bytes'],
  });
  const rawMaxBytes = args.values['max-bytes'];
  const maxBytes = rawMaxBytes ? Number.parseInt(rawMaxBytes, 10) : null;
  if (rawMaxBytes && (!Number.isFinite(maxBytes) || (maxBytes ?? 0) <= 0)) {
    throw new CliError('invalid_args', '--max-bytes must be a positive integer.', EXIT.INVALID_ARGS);
  }
  return { id: args.target, maxBytes };
}

export async function runPacketDiff(mode: OutputMode, rest: string[]): Promise<number> {
  const { id: explicitId, maxBytes } = parseDiffArgs(rest);
  const id = (await resolvePacketTarget(explicitId)).laneId;

  const cfg = resolveConfig();
  const res = await apiFetch<PacketDiff>(
    cfg,
    `/api/lanes/${encodeURIComponent(id)}/diff`,
    maxBytes ? { query: { maxBytes } } : undefined,
  );
  if (!res.data) {
    throw new CliError('invalid_response', 'Server returned an empty diff.', EXIT.INVALID_ARGS);
  }

  if (mode.human) {
    printHumanHeading(`packet diff (${res.data.branch} vs ${res.data.base})`);
    if (res.data.stat) process.stdout.write(`${res.data.stat}\n\n`);
    process.stdout.write(`${res.data.diff || '(no changes)'}\n`);
    if (res.data.truncated) {
      process.stdout.write(`\n[truncated at ${res.data.maxBytes} of ${res.data.sizeBytes} bytes — pass --max-bytes to raise]\n`);
    }
  } else {
    printJson(res.data);
  }
  return 0;
}
