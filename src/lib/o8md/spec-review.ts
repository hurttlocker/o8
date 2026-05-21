/*
 * Headless o8.md review — the background "one-shot lane" for the spec surface.
 *
 * Instead of pre-filling the visible orchestrator composer, the sparkle button
 * calls this: a single LLM turn (dual-path — Claude when the in-app orchestrator
 * toggle is on, else Codex) that READS the operator's o8.md and RETURNS a JSON
 * list of annotations. We apply them via the same splice functions the API/CLI/
 * MCP use (appendComment / insertSuggestion). The orchestrator session is never
 * touched, so the review never appears in the chat — it just lands on the rail.
 *
 * The LLM returns structured JSON (not tool calls): far more reliable for a
 * one-shot than a headless tool-calling loop, and it keeps the whole thing a
 * pure (content) -> (content) transform the route can write + byte-check.
 */

import 'server-only';

import { execSync } from 'node:child_process';
import { callCodex } from '@/lib/cortex/qa/llm/codex-adapter';
import { callSonnet } from '@/lib/cortex/qa/llm/sonnet-adapter';
import { appendComment, insertSuggestion, type SuggestionKind } from './mutate';

/** One annotation the LLM proposes. Mirrors the comment/suggest write surface. */
interface ReviewAnnotation {
  kind?: string;
  anchor?: string;
  body?: string;
  suggestionKind?: string;
  text?: string;
  replacement?: string;
}

export interface SpecReviewResult {
  applied: number;
  skipped: number;
  total: number;
  backend: 'claude' | 'codex';
}

/** Generous cap on the doc slice we hand the model — the o8.md byte cap is
 *  256KB but a notes file is normally tiny; this just bounds a runaway. */
const MAX_CONTENT_CHARS = 24_000;

function recentCommits(repoPath: string): string {
  try {
    return execSync('git log --oneline -20', { cwd: repoPath, encoding: 'utf-8', timeout: 5_000 }).trim();
  } catch {
    return '';
  }
}

function buildPrompt(content: string, commits: string): string {
  const doc = content.length > MAX_CONTENT_CHARS ? content.slice(0, MAX_CONTENT_CHARS) : content;
  return `You are a sharp teammate reading over a colleague's o8.md working notes and leaving margin annotations. Do NOT rewrite their prose — only annotate.

Comment ONLY where there is something real to say. The bar: "would this change what they do or know?" Skip proofreading and the obvious — a few sharp notes beat a wall. The best notes flag: a stale item that already shipped, a decision worth revisiting, a buried question that needs an answer, or something that contradicts a recent commit. If nothing is worth flagging, return an empty array.

Recent commits (use these to judge what's already shipped vs. still open):
${commits || '(unavailable)'}

The o8.md notes:
"""
${doc}
"""

Return ONLY a JSON array (no prose, no markdown code fence) of annotation objects. Each is one of:
- {"kind":"comment","anchor":"<exact phrase copied verbatim from the notes>","body":"<your 1-2 sentence note>"}
- {"kind":"suggestion","suggestionKind":"sub","anchor":"<exact phrase>","replacement":"<new text>"}
- {"kind":"suggestion","suggestionKind":"add","anchor":"<exact phrase to add after>","text":"<text to add>"}
- {"kind":"suggestion","suggestionKind":"del","anchor":"<exact phrase to remove>"}

Hard rules: every "anchor" MUST be an exact, character-for-character substring of the notes above (it is used for a literal text match). Keep each "body" to 1-2 short sentences, terse, no preamble. Never reuse the same anchor twice. Output the JSON array and nothing else.`;
}

/** Pull the JSON array out of a model response (tolerates a code fence / chatter). */
function parseAnnotations(raw: string): ReviewAnnotation[] {
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return [];
  try {
    const parsed = JSON.parse(s.slice(start, end + 1));
    return Array.isArray(parsed) ? (parsed as ReviewAnnotation[]) : [];
  } catch {
    return [];
  }
}

async function runLLM(prompt: string, useClaude: boolean): Promise<string> {
  if (useClaude) {
    const messages = [{ role: 'user' as const, content: prompt }];
    const { text } = await callSonnet({
      system: 'You review o8.md working notes and leave terse margin annotations. You never rewrite the prose. You output ONLY a JSON array of annotation objects and nothing else.',
      messages,
      timeoutMs: 120_000,
    });
    return text;
  }
  return callCodex(prompt, { timeoutMs: 120_000 });
}

/**
 * Run a headless review of `content` (a repo's o8.md) and return the annotated
 * markdown + a summary. Pure transform — the caller writes it (and byte-checks).
 * Bad anchors / unparseable items are skipped, never thrown, so one bad
 * annotation can't sink the batch.
 */
export async function runSpecReview(repoPath: string, content: string): Promise<{ updated: string; result: SpecReviewResult }> {
  let useClaude = false;
  try {
    const { resolveInAppOrchestratorEnabledSync } = await import('@/lib/operator/defaults');
    useClaude = resolveInAppOrchestratorEnabledSync();
  } catch {
    useClaude = false;
  }

  const prompt = buildPrompt(content, recentCommits(repoPath));
  const raw = await runLLM(prompt, useClaude);
  const annotations = parseAnnotations(raw);

  let md = content;
  let applied = 0;
  let skipped = 0;
  const usedAnchors = new Set<string>();

  for (const a of annotations) {
    // Guard against the model reusing an anchor — splicing the same text twice
    // would nest markers and corrupt the doc.
    if (a.anchor && usedAnchors.has(a.anchor)) {
      skipped += 1;
      continue;
    }
    try {
      if (a.kind === 'comment' && typeof a.body === 'string' && a.body.trim()) {
        md = appendComment(md, { body: a.body.trim(), ...(a.anchor ? { anchor: a.anchor } : {}), author: 'AI' });
        applied += 1;
        if (a.anchor) usedAnchors.add(a.anchor);
      } else if (a.kind === 'suggestion' && (a.suggestionKind === 'add' || a.suggestionKind === 'del' || a.suggestionKind === 'sub')) {
        md = insertSuggestion(md, {
          kind: a.suggestionKind as SuggestionKind,
          ...(a.anchor ? { anchor: a.anchor } : {}),
          ...(typeof a.text === 'string' ? { text: a.text } : {}),
          ...(typeof a.replacement === 'string' ? { replacement: a.replacement } : {}),
          author: 'AI',
        });
        applied += 1;
        if (a.anchor) usedAnchors.add(a.anchor);
      } else {
        skipped += 1;
      }
    } catch {
      // Anchor not found / raw delimiter / missing field — skip this one.
      skipped += 1;
    }
  }

  return { updated: md, result: { applied, skipped, total: annotations.length, backend: useClaude ? 'claude' : 'codex' } };
}
