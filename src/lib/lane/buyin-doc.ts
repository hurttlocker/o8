/**
 * Auto buy-in doc on merge (#1492).
 *
 * When a packet merges successfully, this runs fire-and-forget (parallel to the
 * #1491 explainer's machinery, re-skinned for an EXTERNAL audience): it asks the
 * active reviewer backend to emit a single self-contained, shareable HTML doc
 * that leads with demo/visual-proof, then explains what & why in plain language,
 * lists deviations, tails with verification, and pre-answers objections. The
 * HTML is stored as a `report` artifact the released packet card links to.
 *
 * It NEVER blocks or fails a merge — the caller kicks it off without awaiting and
 * the packet carries a `generating → ready | failed` status. On any failure the
 * released card simply shows no buy-in link (status `failed`), never a placeholder.
 *
 * Content safety: the doc is written for external sharing, so the generation
 * prompt forbids secrets/tokens, absolute local paths, and internal URLs; the
 * in-app surface renders it in a sandboxed iframe (allow-scripts, no same-origin)
 * — the same trust boundary as the explainer.
 *
 * Runs against `repoPath` (the merge target), NOT a worktree — the lane worktree
 * is torn down during post-merge cleanup before this fires. The temp HTML file is
 * written at the repo root and unlinked after it is read, so the live repo is
 * left clean.
 */

import { writeFileSync } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  artifactExtForMime,
  artifactRelPath,
  artifactAbsPath,
  ensureArtifactBucket,
  newArtifactId,
  recordArtifact,
} from '@/lib/artifacts/store';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { runReviewerTurnWithQuotaFallback } from './review-quota-fallback';

/**
 * The file the backend agent is told to write at the repo root. PER-PACKET so
 * concurrent same-repo buy-in generations in one merge wave never race on a
 * single fixed path (one's `finally` unlink deleting another's file mid-write).
 */
export function buyinDocFilename(packetId: string): string {
  const safe = packetId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 96) || 'packet';
  return `.o8-buyin-doc-${safe}.html`;
}

/** A demo/proof artifact captured for the packet (screenshot/video). */
export interface BuyinDemoArtifact {
  /** Absolute on-disk path (an INPUT for the agent to read — never emitted). */
  absPath: string;
  label: string | null;
  phase: 'before' | 'after' | null;
  kind: string;
  mimeType: string;
}

export interface GenerateBuyinDocParams {
  repoPath: string;
  laneId: string;
  packetId: string;
  packetTitle: string;
  packetSummary: string;
  mergeSha: string | null;
  deviationsRaw: string | null;
  demoArtifacts: BuyinDemoArtifact[];
}

/**
 * Whether a buy-in doc should be generated for a merge. Pure so the merge hook
 * and tests agree: enabled setting + a successful merge + a real packet id.
 */
export function shouldGenerateBuyinDoc(input: {
  enabled: boolean;
  mergeOk: boolean;
  packetId: string | null | undefined;
}): boolean {
  return Boolean(input.enabled && input.mergeOk && input.packetId && input.packetId.trim());
}

export function buildBuyinDocPrompt(params: GenerateBuyinDocParams): string {
  const imageDemos = params.demoArtifacts.filter((a) => a.kind === 'screenshot' || a.mimeType.startsWith('image/'));
  const videoDemos = params.demoArtifacts.filter((a) => a.kind === 'video' || a.mimeType.startsWith('video/'));

  const demoBlock = imageDemos.length > 0 || videoDemos.length > 0
    ? [
        `Demo / visual proof captured for this packet — LEAD the document with these:`,
        ...imageDemos.map((a, i) => `  - image ${i + 1}${a.phase ? ` (${a.phase})` : ''}${a.label ? `: ${a.label}` : ''} — local file: ${a.absPath}`),
        ...videoDemos.map((a, i) => `  - video ${i + 1}${a.label ? `: ${a.label}` : ''} — local file: ${a.absPath}`),
        `To keep the doc self-contained, READ each image file and inline it as a base64 \`data:\` URI \`<img>\` (before/after images side by side where phases are given). Do NOT hotlink and do NOT inline video bytes — reference a video by its label/caption only.`,
      ].join('\n')
    : `No demo artifacts were captured. Do NOT fabricate screenshots or insert placeholder images — lead instead with a crisp plain-language "what shipped" summary.`;

  return [
    `Write a single self-contained HTML "buy-in doc" for a code change that JUST MERGED, for an EXTERNAL audience (teammates, stakeholders) who did not watch the work and do not read diffs. The goal is to make them understand and believe in what shipped.`,
    ``,
    `Packet: ${params.packetTitle}`,
    params.packetSummary ? `Summary: ${params.packetSummary}` : null,
    params.mergeSha ? `Merged commit: ${params.mergeSha}. You may run git (e.g. \`git show ${params.mergeSha}\`, \`git log\`) in this repo to ground the narrative in what actually changed.` : `You may inspect recent git history in this repo to ground the narrative.`,
    ``,
    demoBlock,
    ``,
    params.deviationsRaw ? `Deviations the worker logged from the plan (surface these honestly under "What changed vs. the plan"):\n${params.deviationsRaw}` : `The worker reported no deviations from the plan.`,
    ``,
    `Produce a SINGLE self-contained .html file at the repo root named exactly \`${buyinDocFilename(params.packetId)}\`.`,
    `Document requirements, in this order:`,
    `1. DEMO / PROOF FIRST — the visual proof (or the plain "what shipped" line if none) is the very first thing the reader sees.`,
    `2. What & why — plain language, no jargon, no diff-speak. What can a user/stakeholder now do that they couldn't before, and why it matters.`,
    `3. What changed vs. the plan — the deviations above, framed as deliberate calls.`,
    `4. Verification — how we know it works (tests, checks, the demo).`,
    `5. Objections pre-answered — the 3-5 hardest "but what about…" questions a skeptic would raise, each answered honestly.`,
    ``,
    `Requirements for the file:`,
    `- Inline ALL CSS; no external assets, no network requests, no external fonts/scripts/stylesheets — it must render offline as one file.`,
    `- CONTENT SAFETY (this doc will be shared externally): do NOT include secrets, API keys, tokens, credentials, or environment variable VALUES. Do NOT include absolute local filesystem paths (e.g. /Users/…, /home/…, C:\\…), machine names, or internal-only URLs (localhost, 127.0.0.1, private IPs, *.internal). Refer to files by repo-relative path only. If unsure whether something is sensitive, leave it out.`,
    ``,
    `Write ONLY that file. Do NOT commit it, do NOT run \`git add\`/\`git commit\`/\`git push\`, do NOT modify any other file. When the file is written, reply with the single word DONE.`,
  ].filter((value): value is string => value !== null).join('\n');
}

/**
 * Kick off buy-in doc generation. Awaitable but designed to be called WITHOUT
 * await (fire-and-forget). Sets the packet's buyinDoc status as it progresses.
 * All failures are swallowed into a `failed` status so the caller never breaks.
 */
export async function generateBuyinDoc(params: GenerateBuyinDocParams): Promise<void> {
  const { patchMissionPacket } = await import('@/lib/orchestrator/operator-mission-service/packet-patch');
  const stamp = async (buyinDoc: NonNullable<OrchestratorPacket['buyinDoc']>) => {
    try {
      await patchMissionPacket(params.packetId, { buyinDoc });
    } catch (error) {
      console.warn(`[buyin-doc] Failed to stamp status for packet ${params.packetId}:`, error);
    }
  };

  await stamp({ status: 'generating', generatedAt: null });

  const docPath = join(params.repoPath, buyinDocFilename(params.packetId));
  const threadId = `buyin-${params.laneId}`;
  try {
    const prompt = buildBuyinDocPrompt(params);
    const turn = await runReviewerTurnWithQuotaFallback({
      laneId: params.laneId,
      repoPath: params.repoPath,
      threadId,
      surface: 'buyin-doc',
      prompt,
      onEvent: (backend, event) => {
      if (event.type === 'error' && event.error) {
        console.warn(`[buyin-doc] ${backend.label} error: ${event.error}`);
      }
      },
    });
    if (!turn.ok) throw new Error(turn.errors.join('; ') || 'reviewer turn failed');

    const html = await readFile(docPath, 'utf8');
    if (!html.trim()) {
      throw new Error('buy-in doc file was empty');
    }

    // Persist the HTML as a `report` artifact (same kind + serve route as #1491).
    const id = newArtifactId();
    const ext = artifactExtForMime('text/html');
    const relPath = artifactRelPath(params.packetId, id, ext);
    ensureArtifactBucket(params.packetId);
    writeFileSync(artifactAbsPath(relPath), html, 'utf8');
    const record = recordArtifact({
      id,
      kind: 'report',
      source: 'manual',
      relPath,
      packetId: params.packetId,
      laneId: params.laneId,
      repoPath: params.repoPath,
      mimeType: 'text/html',
      bytes: Buffer.byteLength(html),
    });

    await stamp({
      status: 'ready',
      artifactId: record?.id ?? id,
      generatedAt: new Date().toISOString(),
    });
    console.log(`[buyin-doc] Ready for packet ${params.packetId} (artifact ${record?.id ?? id})`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await stamp({
      status: 'failed',
      generatedAt: new Date().toISOString(),
      error: message.slice(0, 300),
    });
    console.warn(`[buyin-doc] Generation failed for packet ${params.packetId}: ${message}`);
  } finally {
    // Leave the live repo clean — the temp file is never committed.
    await unlink(docPath).catch(() => {});
  }
}
