/**
 * `o8 packet mirror-proof` — mirror a packet's before/after proof stills onto a
 * GitHub PR as an inline-image comment (#1147 Phase 2). Bytes are hosted on a
 * hidden per-PR prerelease so the repo's git history stays clean.
 *
 *   o8 packet mirror-proof --pr 1234
 *   o8 packet mirror-proof --pr 1234 --repo owner/repo --packet <id>
 *
 * Sibling to `o8 packet capture`: capture records the proof, this surfaces it on
 * the PR. Invoke once a PR exists for the packet (o8 packets usually side-merge,
 * so there's no automatic PR moment).
 */

import { execFileSync } from 'node:child_process';
import { apiFetch, CliError, EXIT } from '../../api.js';
import { resolveConfig } from '../../config.js';
import { printHumanHeading, printHumanKv, printJson, type OutputMode } from '../../output.js';
import { resolvePacketTarget } from './target.js';

interface MirrorArgs {
  prNumber: number | null;
  repoSlug: string | null;
  packetId: string | null;
  laneId: string | null;
}

export function parseMirrorArgs(rest: string[]): MirrorArgs {
  let prNumber: number | null = null;
  let repoSlug: string | null = null;
  let packetId: string | null = null;
  let laneId: string | null = null;

  const take = (tok: string, flag: string, i: { v: number }): string | null => {
    if (tok.startsWith(`${flag}=`)) return tok.slice(flag.length + 1);
    if (tok !== flag) return null;
    const value = rest[++i.v];
    if (!value || value.startsWith('-')) {
      throw new CliError('invalid_args', `${flag} requires a value.`, EXIT.INVALID_ARGS);
    }
    return value;
  };

  for (let idx = 0; idx < rest.length; idx++) {
    const tok = rest[idx];
    const i = { v: idx };
    let val: string | null;
    if ((val = take(tok, '--pr', i)) !== null) prNumber = Number.isFinite(Number(val)) ? Number(val) : null;
    else if ((val = take(tok, '--repo', i)) !== null) repoSlug = val;
    else if ((val = take(tok, '--packet', i)) !== null) packetId = val;
    else if ((val = take(tok, '--lane', i)) !== null) laneId = val;
    else if (!tok.startsWith('-') && prNumber === null && Number.isFinite(Number(tok))) prNumber = Number(tok);
    else if (!tok.startsWith('-') && !packetId) packetId = tok;
    else if (tok.startsWith('-')) {
      throw new CliError('invalid_args', `Unknown o8 packet mirror-proof flag: ${tok}.`, EXIT.INVALID_ARGS);
    } else {
      throw new CliError(
        'invalid_args',
        `Unexpected argument ${tok} for o8 packet mirror-proof.`,
        EXIT.INVALID_ARGS,
        'Pass the packet id once, positionally or with --packet <id>.',
      );
    }
    idx = i.v;
  }

  if (packetId && laneId && packetId !== laneId) {
    throw new CliError(
      'invalid_args',
      `Conflicting explicit packet targets: ${packetId} and ${laneId}.`,
      EXIT.INVALID_ARGS,
      'Pass one packet or lane target.',
    );
  }

  return {
    prNumber,
    repoSlug: repoSlug?.trim() || null,
    packetId: packetId?.trim() || null,
    laneId: laneId?.trim() || null,
  };
}

/** Derive "owner/repo" from the cwd's GitHub remote via gh. Returns null on failure. */
function deriveRepoSlug(): string | null {
  try {
    return execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], {
      encoding: 'utf-8',
      timeout: 10_000,
    }).trim() || null;
  } catch {
    return null;
  }
}

export async function runPacketMirrorProof(mode: OutputMode, rest: string[]): Promise<number> {
  const args = parseMirrorArgs(rest);
  if (!args.prNumber || args.prNumber <= 0) {
    throw new CliError(
      'invalid_args',
      'o8 packet mirror-proof requires --pr <number>.',
      EXIT.INVALID_ARGS,
      'Example: o8 packet mirror-proof --pr 1234',
    );
  }

  const target = await resolvePacketTarget(args.packetId ?? args.laneId);
  const packetId = target.packetId;
  const laneId = target.laneId;

  const repoSlug = args.repoSlug ?? deriveRepoSlug();
  if (!repoSlug) {
    throw new CliError(
      'no_repo',
      'Could not determine the GitHub repo. Pass --repo owner/repo.',
      EXIT.INVALID_ARGS,
    );
  }

  const cfg = resolveConfig();
  const res = await apiFetch<{ mirrored: boolean; reason?: string; assetCount?: number; commentPosted?: boolean; tag?: string }>(
    cfg,
    '/api/panel/artifacts/mirror',
    { method: 'POST', body: { repoSlug, prNumber: args.prNumber, packetId, laneId } },
  );

  const data = res.data;
  if (!data) {
    throw new CliError('mirror_failed', 'Mirror request returned no result.', EXIT.CONFLICT);
  }

  if (mode.human) {
    printHumanHeading('packet mirror-proof');
    printHumanKv([
      ['pr', `#${args.prNumber}`],
      ['repo', repoSlug],
      ['packet', packetId ?? '(by lane)'],
      ['mirrored', data.mirrored ? 'yes' : 'no'],
      ['assets', data.assetCount != null ? String(data.assetCount) : '0'],
      ['comment', data.commentPosted ? 'posted' : data.mirrored ? 'already present' : '(none)'],
      ...(data.reason ? [['reason', data.reason] as [string, string]] : []),
    ]);
  } else {
    printJson({ schema: 'o8/cli/packet.mirror-proof/v1', prNumber: args.prNumber, repoSlug, packetId, laneId, ...data });
  }

  return data.mirrored ? EXIT.OK : EXIT.CONFLICT;
}
