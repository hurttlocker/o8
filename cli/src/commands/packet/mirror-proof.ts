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
import { parsePacketArguments, resolvePacketTarget } from './target.js';

interface MirrorArgs {
  prNumber: number | null;
  repoSlug: string | null;
  packetId: string | null;
  laneId: string | null;
}

export function parseMirrorArgs(rest: string[]): MirrorArgs {
  const args = parsePacketArguments(rest, {
    command: 'mirror-proof',
    valueFlags: ['pr', 'repo'],
    targetFlags: ['packet', 'lane'],
    positionalValues: [{ name: 'pr', matches: (value) => Number.isFinite(Number(value)) }],
  });
  const prNumber = Number.isFinite(Number(args.values.pr)) ? Number(args.values.pr) : null;

  return {
    prNumber,
    repoSlug: args.values.repo?.trim() || null,
    packetId: args.target,
    laneId: null,
  };
}

/** Derive "owner/repo" from the cwd's GitHub remote via gh. Returns null on failure. */
function deriveRepoSlug(): string | null {
  try {
    return execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], {
      windowsHide: true,
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
