/**
 * `o8 packet diff [id] [--max-bytes <n>]` — the packet's code diff (committed +
 * uncommitted) against where its lane diverged from base. Byte-bounded by the
 * server so it stays token-safe; auto-resolves the lane from cwd.
 */

import { apiFetch, CliError, EXIT } from '../../api.js';
import { resolveConfig } from '../../config.js';
import { printHumanHeading, printJson, type OutputMode } from '../../output.js';
import { resolveLaneFromCwd } from './worktree-resolve.js';

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
  let id: string | null = null;
  let maxBytes: number | null = null;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--max-bytes') {
      const value = rest[i + 1];
      const parsed = value ? Number.parseInt(value, 10) : NaN;
      if (Number.isFinite(parsed) && parsed > 0) maxBytes = parsed;
      i++;
      continue;
    }
    if (arg.startsWith('-')) continue;
    if (!id) id = arg.trim();
  }
  return { id, maxBytes };
}

export async function runPacketDiff(mode: OutputMode, rest: string[]): Promise<number> {
  const { id: explicitId, maxBytes } = parseDiffArgs(rest);
  let id = explicitId;
  if (!id) {
    const resolved = await resolveLaneFromCwd();
    if (!resolved) {
      throw new CliError(
        'invalid_args',
        'o8 packet diff [id] needs a packet/lane id (or run from inside a packet worktree).',
        EXIT.INVALID_ARGS,
        'Example: o8 packet diff pkt-abc — or just `o8 packet diff` from `.cortex-worktrees/packet-<id>`.',
      );
    }
    id = resolved.laneId;
  }

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
