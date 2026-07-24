export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/mobile/activity — a chronological feed of recent fleet activity for
 * the o8-mobile native iOS app.
 *
 * Returns `{ events: MobileActivityEvent[] }`, newest-first, capped at ~40.
 *
 * Primary data source: recent git commits across every repo in o8's registry
 * (`~/.o8/repos.json`, via `listRepos()`). One bounded `git log` per repo —
 * merge commits (>1 parent) become `kind: "merge"`, everything else `commit`.
 *
 * Bonus data source: orchestrator packet lifecycle. `syncOrchestratorControlPlaneState`
 * is read once and each packet contributes a single event (keyed off its
 * `lastEventAt`) mapped from current status — dispatched / awaiting_review /
 * merge / alert. The packet model only tracks the *latest* event timestamp, so
 * this is one event per packet, not a full per-transition timeline.
 *
 * Auth is enforced centrally by middleware for browser operator tokens and
 * scoped native-device tokens.
 *
 * Never throws — any failure degrades to `{ events: [] }` (or whatever was
 * collected so far). Commits alone are a complete v1; the packet fold-in is
 * best-effort and isolated behind its own try/catch.
 */

import { NextResponse } from 'next/server';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { buildErrorPayload } from '@/lib/api/error-format';
import { listRepos } from '@/lib/repos/registry';
import { findLaneByPacket, getLaneEvents } from '@/lib/lane/registry';
import type { MobileActivityEvent } from '@/lib/mobile/types';

const execFileAsync = promisify(execFile);

/** Total events returned to the client. */
const MAX_EVENTS = 40;
/** Commits pulled per repo before the global newest-first cap is applied. */
const COMMITS_PER_REPO = 20;

const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' };

// Git `--format` field separators — control chars that cannot appear in a
// commit subject, so splitting is unambiguous (same approach as
// src/lib/panel/git-commits.ts).
const RECORD_SEP = '';
const FIELD_SEP = '';

interface RepoTarget {
  /** Absolute repo root. */
  localPath: string;
  /** Short repo name, e.g. "o8". */
  name: string;
}

type PreviewContext = {
  protocol: string;
  hostname: string;
  apiHost: string;
};

function previewContextFromRequest(request: Request): PreviewContext {
  const url = new URL(request.url);
  const forwardedHost = request.headers.get('x-forwarded-host');
  const host = forwardedHost || request.headers.get('host') || url.host;
  const hostname = host.split(':')[0] || url.hostname;
  return {
    protocol: url.protocol || 'http:',
    hostname,
    apiHost: host,
  };
}

function previewUrlForRepo(repoName: string, context: PreviewContext): string | undefined {
  if (repoName === 'o8' || repoName === 'cortex-ide') {
    return `${context.protocol}//${context.apiHost}/dashboard`;
  }
  if (repoName === 'o8-mobile') {
    return `${context.protocol}//${context.hostname}:8081/.sim`;
  }
  return undefined;
}

/**
 * Repos to scan. Prefers o8's registry (`~/.o8/repos.json`); when the registry
 * is empty or unreadable (fresh install), falls back to the current working
 * directory so the o8 repo itself still produces a feed.
 */
async function resolveRepoTargets(): Promise<RepoTarget[]> {
  try {
    const repos = await listRepos();
    if (repos.length > 0) {
      return repos.map((repo) => ({
        localPath: repo.localPath,
        name: repo.name || path.basename(repo.localPath),
      }));
    }
  } catch {
    // Registry unreadable — fall through to the cwd fallback.
  }
  const cwd = process.cwd();
  return [{ localPath: cwd, name: path.basename(cwd) }];
}

/** Resolve the current branch of a repo, or null if it cannot be determined. */
async function resolveBranch(repoRoot: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', repoRoot, 'rev-parse', '--abbrev-ref', 'HEAD'],
      { timeout: 5_000, maxBuffer: 64 * 1024 },
    );
    const branch = stdout.trim();
    return branch && branch !== 'HEAD' ? branch : null;
  } catch {
    return null;
  }
}

/**
 * Recent commits for one repo, mapped to activity events. A commit with more
 * than one parent is a merge. Returns [] on any git failure (missing repo,
 * not a git dir, detached state).
 */
async function collectRepoCommits(
  repo: RepoTarget,
  previewContext: PreviewContext,
): Promise<MobileActivityEvent[]> {
  let stdout: string;
  try {
    const result = await execFileAsync(
      'git',
      [
        '-C',
        repo.localPath,
        'log',
        `--max-count=${COMMITS_PER_REPO}`,
        '--date=iso-strict',
        // record-sep, full hash, parent hashes, subject, committer date
        `--format=${RECORD_SEP}%H${FIELD_SEP}%P${FIELD_SEP}%s${FIELD_SEP}%cI`,
      ],
      { timeout: 10_000, maxBuffer: 1024 * 1024 },
    );
    stdout = result.stdout;
  } catch {
    return [];
  }

  const branch = await resolveBranch(repo.localPath);

  return stdout
    .split(RECORD_SEP)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk): MobileActivityEvent | null => {
      const [sha = '', parents = '', subject = '', dateIso = ''] = chunk.split(FIELD_SEP);
      if (!sha) return null;

      const timestamp = Date.parse(dateIso);
      if (!Number.isFinite(timestamp)) return null;

      const shortHash = sha.slice(0, 7);
      const isMerge = parents.trim().split(/\s+/).filter(Boolean).length > 1;

      return {
        id: `commit:${sha}`,
        kind: isMerge ? 'merge' : 'commit',
        title: subject.trim() || '(no commit message)',
        detail: branch ? `${branch} · ${shortHash}` : shortHash,
        previewUrl: previewUrlForRepo(repo.name, previewContext),
        repo: repo.name,
        timestamp,
      };
    })
    .filter((event): event is MobileActivityEvent => event !== null);
}

/**
 * Best-effort orchestrator packet events. Each packet contributes at most one
 * event, keyed off `lastEventAt`. The packet model only carries the latest
 * event timestamp, so this is a snapshot of where each packet currently is —
 * not a reconstructed transition history. Isolated behind its own try/catch:
 * any failure here must not affect the commit feed.
 */
async function collectPacketEvents(previewContext: PreviewContext): Promise<MobileActivityEvent[]> {
  try {
    // Lazy import — keeps the orchestrator control-plane (and its deps) off
    // the hot path when this bonus source is not reachable.
    const { syncOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
    const mission = await syncOrchestratorControlPlaneState();
    const packets = Array.isArray(mission.packets) ? mission.packets : [];

    return packets
      .map((packet): MobileActivityEvent | null => {
        const lane = findLaneByPacket(packet.id);
        const eventTime = packet.lastEventAt || packet.archivedAt;
        const timestamp = eventTime ? Date.parse(eventTime) : Number.NaN;
        if (!Number.isFinite(timestamp)) return null;

        const released = packet.releaseState === 'released' || packet.status === 'released';
        const huddleLabel = packet.lastEventLabel === 'huddle'
          || packet.lastEventLabel === 'huddle_ready'
          || packet.lane?.lastEventLabel === 'huddle'
          || packet.lane?.lastEventLabel === 'huddle_ready'
          || (lane?.status === 'awaiting_orchestrator' && (lane.lastEventLabel === 'huddle' || lane.lastEventLabel === 'huddle_ready'));
        let kind: MobileActivityEvent['kind'];
        if (released) {
          kind = 'merge';
        } else if (huddleLabel) {
          kind = 'huddle';
        } else if (
          packet.status === 'failed'
          || packet.status === 'blocked'
          || packet.status === 'archived'
        ) {
          kind = 'alert';
        } else if (packet.status === 'awaiting_review') {
          kind = 'awaiting_review';
        } else if (
          packet.status === 'launching'
          || packet.status === 'running'
          || packet.status === 'idle'
          || packet.status === 'recovering'
        ) {
          kind = 'dispatched';
        } else {
          // draft / queued — not yet meaningful activity, skip.
          return null;
        }

        const title = packet.title?.trim() || packet.summary?.trim() || 'Untitled packet';
        const branch = packet.branchTarget?.trim();
        const detail = packet.recovery?.message?.trim()
          || packet.lastEventLabel?.trim()
          || (branch ? `${branch} → main` : undefined);
        const huddlePlan = lane
          ? [...getLaneEvents(lane.id, 100)].reverse().find((event) =>
              event.verb === 'agent_report' && event.payload.event === 'huddle'
            )?.payload.message
          : undefined;

        const repo = packet.workspaceTargetPath
          ? path.basename(packet.workspaceTargetPath)
          : undefined;

        return {
          id: `packet:${packet.id}`,
          kind,
          title: title.slice(0, 160),
          detail: kind === 'huddle' ? 'Huddling — aligned its plan, awaiting orchestrator' : detail,
          comments: typeof huddlePlan === 'string' && huddlePlan.trim()
            ? [huddlePlan.trim()]
            : packet.recovery?.message
              ? [packet.recovery.message]
              : undefined,
          repo,
          previewUrl: repo ? previewUrlForRepo(repo, previewContext) : undefined,
          timestamp,
        };
      })
      .filter((event): event is MobileActivityEvent => event !== null);
  } catch (error) {
    console.log('[mobile/activity] packet events unavailable', error);
    return [];
  }
}

export async function GET(request: Request) {
  try {
    const repos = await resolveRepoTargets();
    const previewContext = previewContextFromRequest(request);

    // Commits across all repos run in parallel; one failing repo cannot sink
    // the feed (allSettled + per-repo try/catch inside collectRepoCommits).
    const [commitResults, packetEvents] = await Promise.all([
      Promise.allSettled(repos.map((repo) => collectRepoCommits(repo, previewContext))),
      collectPacketEvents(previewContext),
    ]);

    const events: MobileActivityEvent[] = [];
    for (const result of commitResults) {
      if (result.status === 'fulfilled') events.push(...result.value);
    }
    events.push(...packetEvents);

    events.sort((a, b) => b.timestamp - a.timestamp);

    return NextResponse.json(
      { events: events.slice(0, MAX_EVENTS) },
      { headers: NO_STORE },
    );
  } catch (error) {
    console.error('[mobile/activity] Failed to build activity feed', error);
    return NextResponse.json(
      { events: [], ...buildErrorPayload('Failed to load activity feed.', error) },
      { status: 500, headers: NO_STORE },
    );
  }
}
