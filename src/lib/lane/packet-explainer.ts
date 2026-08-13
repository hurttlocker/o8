/**
 * HTML packet explainer + quiz generation (#1491).
 *
 * When a packet reaches review, this runs fire-and-forget alongside the
 * auto-review: it asks the active reviewer backend to emit a self-contained
 * HTML explainer (what/why, annotated hunks, data flow, deviations, risk) plus
 * a structured multiple-choice quiz, then stores the HTML as a `report`
 * artifact and stamps the parsed quiz onto the packet.
 *
 * It NEVER blocks the review transition — the caller kicks it off without
 * awaiting and the packet carries a `generating → ready | failed` status. On any
 * failure the review surface degrades to the raw diff (status `failed`).
 *
 * The quiz is parsed out to STRUCTURED data here (app code), never read from
 * inside the sandboxed iframe, so the approve-gate logic stays in the app.
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
import type { PacketExplainerQuiz } from '@/lib/orchestrator/types';
import { runReviewerTurnWithQuotaFallback } from './review-quota-fallback';
import type { Lane } from './types';

/**
 * The file the backend agent is told to write in the worktree root. PER-PACKET
 * so two lanes reviewing in the same repo (worktreePath falling back to
 * repoPath) never race on a single fixed path.
 */
function explainerFilename(packetId: string): string {
  const safe = packetId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 96) || 'packet';
  return `.o8-packet-explainer-${safe}.html`;
}

interface GenerateExplainerParams {
  lane: Lane;
  packetId: string;
  packetTitle: string;
  packetSummary: string;
  diffSummary: string;
  changedFileCount: number;
  deviationsRaw: string | null;
  reviewContext: string;
}

/**
 * Extract + validate the `<script type="application/json" id="o8-quiz">` block
 * from the explainer HTML. Returns null when absent or malformed — the gate
 * degrades to ungated in that case.
 */
export function parseExplainerQuiz(html: string): PacketExplainerQuiz | null {
  const match = html.match(/<script[^>]*id=["']o8-quiz["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1].trim());
  } catch {
    return null;
  }
  const rawQuestions = Array.isArray(parsed)
    ? parsed
    : (parsed && typeof parsed === 'object' && Array.isArray((parsed as { questions?: unknown }).questions)
      ? (parsed as { questions: unknown[] }).questions
      : null);
  if (!rawQuestions) return null;

  const questions = rawQuestions
    .map((entry, index) => {
      if (!entry || typeof entry !== 'object') return null;
      const q = entry as { id?: unknown; prompt?: unknown; question?: unknown; options?: unknown; answerIndex?: unknown };
      const prompt = typeof q.prompt === 'string' ? q.prompt.trim()
        : typeof q.question === 'string' ? q.question.trim() : '';
      const options = Array.isArray(q.options)
        ? q.options.map((option) => String(option).trim()).filter(Boolean).slice(0, 8)
        : [];
      const answerIndex = typeof q.answerIndex === 'number' && Number.isInteger(q.answerIndex) ? q.answerIndex : -1;
      if (!prompt || options.length < 2 || answerIndex < 0 || answerIndex >= options.length) return null;
      return {
        id: typeof q.id === 'string' && q.id.trim() ? q.id.trim() : `q${index + 1}`,
        prompt,
        options,
        answerIndex,
      };
    })
    .filter((question): question is NonNullable<typeof question> => question !== null)
    .slice(0, 6);

  return questions.length >= 3 ? { questions } : null;
}

function buildExplainerPrompt(params: GenerateExplainerParams): string {
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
    `Produce a SINGLE self-contained .html file at the worktree root named exactly \`${explainerFilename(params.packetId)}\`.`,
    `Requirements for the file:`,
    `- Inline all CSS; no external assets, no network requests.`,
    `- Sections: what & why (plain language), annotated key hunks (the 2-4 most important changes), data flow touched, deviations from brief, risk notes.`,
    `- End with a quiz of 3 to 6 multiple-choice questions that test real comprehension of THIS change (not trivia). Render the quiz visibly for the reader.`,
    `- ALSO embed the quiz as STRUCTURED JSON in exactly this element so the app can read it:`,
    `  <script type="application/json" id="o8-quiz">{"questions":[{"id":"q1","prompt":"…","options":["…","…","…"],"answerIndex":0}]}</script>`,
    `  answerIndex is the 0-based index of the correct option. Include every quiz question in the JSON.`,
    ``,
    `Write ONLY that file. Do NOT commit it, do NOT run git, do NOT modify any other file. When the file is written, reply with the single word DONE.`,
  ].filter((value): value is string => value !== null).join('\n');
}

/**
 * Kick off explainer generation. Awaitable but designed to be called WITHOUT
 * await (fire-and-forget). Sets the packet's explainer status as it progresses.
 * All failures are swallowed into a `failed` status so the caller never breaks.
 */
export async function generatePacketExplainer(params: GenerateExplainerParams): Promise<void> {
  const { patchMissionPacket } = await import('@/lib/orchestrator/operator-mission-service/packet-patch');
  const stamp = async (explainer: NonNullable<import('@/lib/orchestrator/types').OrchestratorPacket['explainer']>) => {
    try {
      await patchMissionPacket(params.packetId, { explainer });
    } catch (error) {
      console.warn(`[explainer] Failed to stamp explainer status for packet ${params.packetId}:`, error);
    }
  };

  await stamp({ status: 'generating', changedFileCount: params.changedFileCount, generatedAt: null });

  try {
    const threadId = `explainer-${params.lane.id}`;
    const prompt = buildExplainerPrompt(params);
    const turn = await runReviewerTurnWithQuotaFallback({
      laneId: params.lane.id,
      repoPath: params.lane.repoPath,
      threadId,
      surface: 'packet-explainer',
      prompt,
      onEvent: (backend, event) => {
      if (event.type === 'error' && event.error) {
        console.warn(`[explainer] ${backend.label} error: ${event.error}`);
      }
      },
    });
    if (!turn.ok) throw new Error(turn.errors.join('; ') || 'reviewer turn failed');

    const worktree = params.lane.worktreePath || params.lane.repoPath;
    const scratchPath = join(worktree, explainerFilename(params.packetId));
    const html = await readFile(scratchPath, 'utf8');
    if (!html.trim()) {
      throw new Error('explainer file was empty');
    }

    const quiz = parseExplainerQuiz(html);

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
      quiz: quiz ?? null,
      changedFileCount: params.changedFileCount,
      generatedAt: new Date().toISOString(),
    });
    console.log(`[explainer] Ready for packet ${params.packetId} (${quiz?.questions.length ?? 0} quiz questions)`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await stamp({
      status: 'failed',
      changedFileCount: params.changedFileCount,
      generatedAt: new Date().toISOString(),
      error: message.slice(0, 300),
    });
    console.warn(`[explainer] Generation failed for packet ${params.packetId}: ${message}`);
  }
}
