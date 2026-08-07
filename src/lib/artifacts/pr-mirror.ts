/**
 * #1147 Phase 2 — GitHub PR proof mirror. Posts an agent's before/after stills
 * onto a GitHub PR as an inline-image comment, hosting the bytes as assets on a
 * hidden per-PR prerelease (`o8-proof-pr-<n>`) so the repo's git history stays
 * clean — zero bloat (operator-chosen mechanism, Jun 1).
 *
 * Invoked explicitly (CLI `o8 packet mirror-proof` / POST /api/panel/artifacts/
 * mirror) once a PR exists for a packet — o8 packets normally side-merge, so
 * there's no automatic "packet got a PR" moment to hook. Best-effort: never
 * throws; the in-app proof strips remain the source of truth.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { listArtifacts, artifactAbsPath, type ArtifactRecord } from './store';

const execFileP = promisify(execFile);
const PROOF_MARKER = '<!-- o8-visual-proof -->';
const GH_TIMEOUT_MS = 20_000;

export interface MirrorProofArgs {
  /** "owner/repo". */
  repoSlug: string;
  prNumber: number;
  packetId?: string | null;
  laneId?: string | null;
}

export interface MirrorProofResult {
  mirrored: boolean;
  reason?: string;
  assetCount?: number;
  commentPosted?: boolean;
  tag?: string;
}

async function gh(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileP('gh', args, { windowsHide: true, timeout: GH_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 });
    return { ok: true, stdout: stdout.toString(), stderr: stderr.toString() };
  } catch (err) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string };
    return { ok: false, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') };
  }
}

function assetUrl(repoSlug: string, tag: string, fileName: string): string {
  // GitHub release-download URLs use the raw asset filename (no percent-encoding),
  // and our filenames are controlled — `art-<uuid>.<ext>` from newArtifactId — so
  // they never contain URL-special chars. Pass through verbatim to match the name
  // gh assigns the uploaded asset.
  return `https://github.com/${repoSlug}/releases/download/${tag}/${fileName}`;
}

interface MdGroup { label: string | null; before: ArtifactRecord | null; after: ArtifactRecord | null; single: ArtifactRecord | null }

/** Group oldest-first artifacts into before/after pairs (pairId, then shared label) + singles — mirrors the client groupArtifacts so the PR comment matches the in-app strip. */
function groupForMarkdown(rows: ArtifactRecord[]): MdGroup[] {
  const byKey = new Map<string, MdGroup>();
  const out: MdGroup[] = [];
  for (const a of rows) {
    const key = a.phase
      ? (a.pairId ? `pair:${a.pairId}` : (a.label ? `label:${a.label.trim().toLowerCase()}` : null))
      : null;
    if (key) {
      let g = byKey.get(key);
      if (!g) { g = { label: a.label ?? null, before: null, after: null, single: null }; byKey.set(key, g); out.push(g); }
      if (a.phase === 'before') g.before = a; else g.after = a;
      if (!g.label && a.label) g.label = a.label;
    } else {
      out.push({ label: a.label ?? null, before: null, after: null, single: a });
    }
  }
  return out;
}

export async function mirrorProofToPr(args: MirrorProofArgs): Promise<MirrorProofResult> {
  const { repoSlug, prNumber } = args;
  if (!repoSlug || !/^[^/\s]+\/[^/\s]+$/.test(repoSlug) || !Number.isInteger(prNumber) || prNumber <= 0) {
    return { mirrored: false, reason: 'invalid repoSlug ("owner/repo") or prNumber' };
  }

  // Gather screenshots for this packet (or lane). Pass ONE key — listArtifacts AND-combines.
  const filter = args.packetId ? { packetId: args.packetId } : args.laneId ? { laneId: args.laneId } : null;
  if (!filter) return { mirrored: false, reason: 'provide packetId or laneId' };
  const rows = listArtifacts(filter).filter((a) => a.kind === 'screenshot');
  if (rows.length === 0) return { mirrored: false, reason: 'no proof screenshots for this packet/lane' };

  // Resolve on-disk files (skip rows whose bytes are gone).
  const files = rows
    .map((a) => ({ a, abs: artifactAbsPath(a.relPath), name: basename(a.relPath) }))
    .filter((f) => existsSync(f.abs));
  if (files.length === 0) return { mirrored: false, reason: 'artifact files missing on disk' };
  const usableRows = rows.filter((a) => files.some((f) => f.a.id === a.id));

  const tag = `o8-proof-pr-${prNumber}`;
  const title = `o8 visual proof — PR #${prNumber}`;
  const notes = `Agent-captured before/after stills for PR #${prNumber}. Hosted by o8 as release assets so they stay out of git history.`;
  const absPaths = files.map((f) => f.abs);

  // Upload: create the hidden prerelease with the files, or clobber-upload if it already exists.
  const created = await gh(['release', 'create', tag, '-R', repoSlug, '--prerelease', '--title', title, '--notes', notes, ...absPaths]);
  if (!created.ok) {
    const up = await gh(['release', 'upload', tag, '-R', repoSlug, '--clobber', ...absPaths]);
    if (!up.ok) {
      return { mirrored: false, reason: `gh release upload failed: ${(up.stderr || created.stderr).slice(0, 200)}`.trim(), tag };
    }
  }

  // Build the comment markdown (Bug/Fixed framing, matching the in-app strip).
  const sections: string[] = [];
  for (const g of groupForMarkdown(usableRows)) {
    const parts: string[] = [];
    if (g.label) parts.push(`**${g.label}**`);
    if (g.single) {
      parts.push(`![capture](${assetUrl(repoSlug, tag, basename(g.single.relPath))})`);
    } else {
      if (g.before) parts.push(`Bug:\n\n![before](${assetUrl(repoSlug, tag, basename(g.before.relPath))})`);
      if (g.after) parts.push(`Fixed:\n\n![after](${assetUrl(repoSlug, tag, basename(g.after.relPath))})`);
    }
    sections.push(parts.join('\n\n'));
  }
  const body = [
    PROOF_MARKER,
    '### Visual proof — agent capture',
    '',
    sections.join('\n\n---\n\n'),
    '',
    '_Captured by o8 while the change was live. The operator verifies by seeing._',
  ].join('\n');

  // Idempotent: if a proof comment already exists, EDIT it in place so newly
  // captured stills appear and images refresh; else post a fresh comment. The
  // REST comment id is recovered from the comment's html url (#issuecomment-N).
  const view = await gh(['pr', 'view', String(prNumber), '-R', repoSlug, '--json', 'comments']);
  let existingCommentId: string | null = null;
  if (view.ok) {
    try {
      const parsed = JSON.parse(view.stdout) as { comments?: Array<{ body?: string; url?: string }> };
      const existing = (parsed.comments ?? []).find((c) => (c.body ?? '').includes(PROOF_MARKER));
      const m = existing?.url?.match(/issuecomment-(\d+)/);
      if (m) existingCommentId = m[1];
    } catch { /* ignore parse failure — fall through to post a fresh comment */ }
  }

  let commentPosted = false;
  if (existingCommentId) {
    const edited = await gh(['api', '-X', 'PATCH', `/repos/${repoSlug}/issues/comments/${existingCommentId}`, '-f', `body=${body}`]);
    commentPosted = edited.ok;
    if (!edited.ok) {
      return { mirrored: true, reason: `assets uploaded but comment edit failed: ${edited.stderr.slice(0, 200)}`.trim(), assetCount: files.length, commentPosted: false, tag };
    }
  } else {
    const posted = await gh(['pr', 'comment', String(prNumber), '-R', repoSlug, '--body', body]);
    commentPosted = posted.ok;
    if (!posted.ok) {
      return { mirrored: true, reason: `assets uploaded but comment failed: ${posted.stderr.slice(0, 200)}`.trim(), assetCount: files.length, commentPosted: false, tag };
    }
  }

  return { mirrored: true, assetCount: files.length, commentPosted, tag };
}
