/*
 * Headless o8.md review — the background "one-shot lane" for the spec surface.
 *
 * Instead of pre-filling the visible orchestrator composer, the sparkle button
 * calls this: a single LLM turn (Sonnet-5 at xhigh effort through the warm
 * subscription REPL pool, decoupled from the orchestrator/Brain toggles; Codex
 * only as a fallback when no `claude` binary resolves or the warm call throws)
 * that READS the operator's o8.md and RETURNS a JSON list of annotations. We
 * apply them via the same splice functions the API/CLI/MCP use (appendComment /
 * insertSuggestion). The orchestrator session is never touched, so the review
 * never appears in the chat — it just lands on the rail.
 *
 * The LLM returns structured JSON (not tool calls): far more reliable for a
 * one-shot than a headless tool-calling loop, and it keeps the whole thing a
 * pure (content) -> (content) transform the route can write + byte-check.
 */

import 'server-only';

import { execSync } from 'node:child_process';
import { askClaudeWarm, prewarmClaudeRepl } from '@/lib/claude-code/warm-repl-pool';
import { defaultClaudeBin } from '@/lib/claude-code/one-shot-repl';
import { callCodex } from '@/lib/cortex/qa/llm/codex-adapter';
import { MODEL_IDS } from '@/lib/models';
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

/**
 * The o8.md review always runs on Sonnet-5 at xhigh effort through the warm
 * subscription REPL pool — decoupled from the orchestrator/Brain toggles (the
 * routing lives in {@link runLLM}). Deliberately NOT the shared SONNET_CLI_MODEL
 * in sonnet-adapter.ts, which has other callers pinned to a different model.
 */
const REVIEW_MODEL = MODEL_IDS.claudeReviewDefault;
const REVIEW_EFFORT = 'xhigh';
/** System framing prepended to the user prompt for the warm one-shot frame
 *  (mirrors callSonnetCli's `<system>…</system>` shape, sonnet-adapter.ts). */
const REVIEW_SYSTEM = 'You review o8.md working notes and leave terse margin annotations. You never rewrite the prose. You output ONLY a JSON array of annotation objects and nothing else.';

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

/**
 * Run the review turn. Routes to Sonnet-5 at xhigh effort through the warm
 * subscription pool — DECOUPLED from the orchestrator/Brain toggles so the
 * review always gets that path — and only falls back to Codex when no `claude`
 * binary resolves or the warm call throws. Reports the backend it actually used.
 */
async function runLLM(prompt: string): Promise<{ text: string; backend: 'claude' | 'codex' }> {
  const binary = defaultClaudeBin();
  // TODO(prewarm): fire prewarmClaudeRepl(binary, REVIEW_MODEL, REVIEW_EFFORT) on pane focus so the first click is warm.
  if (binary) {
    try {
      // Prepend the system block the way callSonnetCli does — the one-shot
      // frame only carries a `user` message (sonnet-adapter.ts:188-191).
      const framed = `<system>\n${REVIEW_SYSTEM}\n</system>\n\n${prompt}`;
      const text = await askClaudeWarm(framed, {
        binary,
        model: REVIEW_MODEL,
        effort: REVIEW_EFFORT,
        timeoutMs: 120_000,
      });
      return { text, backend: 'claude' };
    } catch {
      // Warm-Claude path unavailable (bad binary / spawn error) — fall to Codex.
    }
  }
  const text = await callCodex(prompt, { timeoutMs: 120_000 });
  return { text, backend: 'codex' };
}

/**
 * Warm a sonnet-5|xhigh REPL so the FIRST "Ask o8 to review" click doesn't
 * cold-spawn. Fire-and-forget + idempotent (the pool keeps at most one idle proc
 * per key), so calling it per pane-open just maintains one warm proc; it reaps
 * after the pool's idle window if it's never used. (2026-07-02)
 */
export function prewarmReview(): void {
  const binary = defaultClaudeBin();
  if (!binary) return;
  try { prewarmClaudeRepl(binary, REVIEW_MODEL, REVIEW_EFFORT); } catch { /* best effort */ }
}

/**
 * Run a headless review of `content` (a repo's o8.md) and return the annotated
 * markdown + a summary. Pure transform — the caller writes it (and byte-checks).
 * Bad anchors / unparseable items are skipped, never thrown, so one bad
 * annotation can't sink the batch.
 */
export async function runSpecReview(repoPath: string, content: string): Promise<{ updated: string; result: SpecReviewResult }> {
  const prompt = buildPrompt(content, recentCommits(repoPath));
  const { text: raw, backend } = await runLLM(prompt);
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

  return { updated: md, result: { applied, skipped, total: annotations.length, backend } };
}
