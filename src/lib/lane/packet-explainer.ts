/**
 * Generate an optional HTML report explaining a completed change.
 * Stores the report as an artifact without blocking review or merge.
 */

import { createHash, randomUUID } from 'node:crypto';
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
import { runReviewerTurnWithQuotaFallback } from './review-quota-fallback';
import type { Lane } from './types';

/**
 * The scratch file is unique per attempt, including retries of the same packet.
 * A detached older writer cannot replace or delete its successor's output.
 */
function explainerFilename(packetId: string, generationId: string): string {
  const safe = packetId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 96) || 'packet';
  const attempt = createHash('sha256').update(generationId).digest('hex').slice(0, 16);
  return `.o8-packet-explainer-${safe}-${attempt}.html`;
}

export interface GenerateExplainerParams {
  lane: Lane;
  packetId: string;
  packetTitle: string;
  packetSummary: string;
  diffSummary: string;
  changedFileCount: number;
  deviationsRaw: string | null;
  reviewContext: string;
  signal?: AbortSignal;
  generationId?: string;
  /** Evaluated again under the packet lock before publishing a late result. */
  isCurrent?: () => boolean;
}

export interface PacketExplainerGenerationResult {
  outcome: 'ready' | 'deferred' | 'failed';
  backend: string | null;
  durationMs: number;
  approximateCost: number | null;
  reason?: string;
}

function buildExplainerPrompt(params: GenerateExplainerParams, generationId: string): string {
  return [
    `Write a self-contained HTML "packet explainer" for a code change under review, so a human who does NOT read diffs can understand and verify it.`,
    ``,
    `Packet: ${params.packetTitle}`,
    params.packetSummary ? `Summary: ${params.packetSummary}` : null,
    ``,
    params.diffSummary,
    ``,
    params.deviationsRaw ? `Worker-reported deviations from the brief:\n${params.deviationsRaw}` : 'Worker reported no deviations.',
    ``,
    `Reviewer context (findings so far):`,
    params.reviewContext || '(none yet)',
    ``,
    `Produce a SINGLE self-contained .html file at the worktree root named exactly \`${explainerFilename(params.packetId, generationId)}\`.`,
    `Requirements for the file:`,
    `- Do not include quizzes or comprehension tests.`,
    `- Inline all CSS; no external assets, no network requests.`,
    `- Sections: what & why (plain language), annotated key hunks (the 2-4 most important changes), data flow touched, deviations from brief, risk notes.`,
    ``,
    `Write ONLY that file. Do NOT commit it, do NOT run git, do NOT modify any other file. When the file is written, reply with the single word DONE.`,
  ].filter((value): value is string => value !== null).join('\n');
}

/**
 * Kick off explainer generation. Awaitable but designed to be called WITHOUT
 * await (fire-and-forget). Sets the packet's explainer status as it progresses.
 * All failures are swallowed into a `failed` status so the caller never breaks.
 */
export async function generatePacketExplainer(
  params: GenerateExplainerParams,
): Promise<PacketExplainerGenerationResult> {
  const startedAt = Date.now();
  const generationId = params.generationId ?? `thoughts-explainer-${randomUUID()}`;
  const isCurrent = () => !params.signal?.aborted && (params.isCurrent?.() ?? true);
  let observedBackend: string | null = null;
  let observedCost: number | null = null;
  const { patchMissionPacket } = await import('@/lib/orchestrator/operator-mission-service/packet-patch');
  const stamp = async (explainer: NonNullable<import('@/lib/orchestrator/types').OrchestratorPacket['explainer']>) => {
    try {
      await patchMissionPacket(params.packetId, { explainer }, isCurrent);
    } catch (error) {
      console.warn(`[explainer] Failed to stamp explainer status for packet ${params.packetId}:`, error);
    }
  };

  try {
    if (!isCurrent()) return { outcome: 'deferred', backend: null, durationMs: 0, approximateCost: null };
    const threadId = generationId;
    const prompt = buildExplainerPrompt(params, generationId);
    const turn = await runReviewerTurnWithQuotaFallback({
      laneId: params.lane.id,
      repoPath: params.lane.repoPath,
      threadId,
      surface: 'packet-explainer',
      prompt,
      signal: params.signal,
      onEvent: (backend, event) => {
        if (event.type === 'error' && event.error) {
          console.warn(`[explainer] ${backend.label} error: ${event.error}`);
        }
      },
    });
    observedBackend = turn.backend;
    observedCost = turn.approximateCost;
    if (!isCurrent()) {
      return {
        outcome: 'deferred',
        backend: turn.backend,
        durationMs: Date.now() - startedAt,
        approximateCost: turn.approximateCost,
        reason: 'explainer was cancelled or superseded',
      };
    }
    if (turn.unavailableReason === 'session_busy') {
      return {
        outcome: 'deferred',
        backend: turn.backend,
        durationMs: Date.now() - startedAt,
        approximateCost: turn.approximateCost,
        reason: 'reviewer backend was busy',
      };
    }
    if (!turn.ok) throw new Error(turn.errors.join('; ') || 'reviewer turn failed');

    const worktree = params.lane.worktreePath || params.lane.repoPath;
    const scratchPath = join(worktree, explainerFilename(params.packetId, generationId));
    const html = await readFile(scratchPath, 'utf8');
    if (!isCurrent()) {
      return { outcome: 'deferred', backend: turn.backend, durationMs: Date.now() - startedAt,
        approximateCost: turn.approximateCost, reason: 'explainer was superseded while reading output' };
    }
    if (!html.trim()) {
      throw new Error('explainer file was empty');
    }


    // Persist the HTML as a `report` artifact.
    const id = newArtifactId();
    const ext = artifactExtForMime('text/html');
    const relPath = artifactRelPath(params.packetId, id, ext);
    ensureArtifactBucket(params.packetId);
    writeFileSync(artifactAbsPath(relPath), html, 'utf8');
    const record = recordArtifact({
      id,
      kind: 'report',
      source: 'review-boundary',
      relPath,
      packetId: params.packetId,
      laneId: params.lane.id,
      repoPath: params.lane.repoPath,
      mimeType: 'text/html',
      bytes: Buffer.byteLength(html),
    });

    // The durable copy now lives outside the lane worktree. Best-effort cleanup
    // keeps generated review files from lingering without turning a successful
    // persistence into a failed explainer if the filesystem refuses deletion.
    await unlink(scratchPath).catch((error) => {
      console.warn(`[explainer] Failed to remove scratch HTML for packet ${params.packetId}:`, error);
    });

    await stamp({
      status: 'ready',
      artifactId: record?.id ?? id,
      quiz: null,
      changedFileCount: params.changedFileCount,
      generatedAt: new Date().toISOString(),
    });
    console.log(`[explainer] Ready for packet ${params.packetId}`);
    return {
      outcome: 'ready',
      backend: turn.backend,
      durationMs: Date.now() - startedAt,
      approximateCost: turn.approximateCost,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!isCurrent()) {
      return {
        outcome: 'deferred',
        backend: observedBackend,
        durationMs: Date.now() - startedAt,
        approximateCost: observedCost,
        reason: 'correctness review took priority',
      };
    }
    console.warn(`[explainer] Generation failed for packet ${params.packetId}: ${message}`);
    return {
      outcome: 'failed',
      backend: observedBackend,
      durationMs: Date.now() - startedAt,
      approximateCost: observedCost,
      reason: message,
    };
  }
}
