/**
 * Digest + fetch_raw operator tools — Fable Slice 5 (2026-07-02).
 *
 * The metered-orchestrator window never absorbs raw bulk: `digest` routes any
 * inbound bulk (logs, test output, a diff, docs, a pasted dump) through a fresh
 * Codex-medium read-only exec (adversarial digestion — the digest never comes
 * from the proposing session) and returns a compact actionable summary.
 * `fetch_raw` is the DELIBERATE hole in that wall: the raw packet-transcript
 * escape for when a digest isn't trustworthy enough to decide on. It is
 * rate-limited per MCP-server process (= per orchestrator session) and METERED,
 * not shamed — a low-confidence orchestrator choosing to fetch raw is the
 * system working (Q synthesis #3). Both tools ride the operator server, so
 * every backend gets them; the fable profile denies the always-available
 * `o8_packet_transcript` (Slice 3) and leaves this metered escape.
 */

import { apiFetch, errorText, jsonResult, textResult, type McpTool, type McpToolResult } from './shared';
import { handleTranscript } from './status';

// ── fetch_raw rate limiter ────────────────────────────────────────────────────

/** Max fetch_raw calls per rolling window (per MCP-server proc = per session). */
export const FETCH_RAW_LIMIT = 5;
export const FETCH_RAW_WINDOW_MS = 10 * 60_000;

const fetchRawCallsAt: number[] = [];

export interface FetchRawMeter {
  allowed: boolean;
  used: number;
  remaining: number;
  retryAfterMs: number;
}

/**
 * Sliding-window check. When allowed, the call is recorded. Pure given `now` —
 * exported for tests (pass explicit timestamps; never call Date.now in tests).
 */
export function fetchRawRateCheck(now: number = Date.now()): FetchRawMeter {
  const windowStart = now - FETCH_RAW_WINDOW_MS;
  while (fetchRawCallsAt.length > 0 && fetchRawCallsAt[0]! <= windowStart) fetchRawCallsAt.shift();
  const used = fetchRawCallsAt.length;
  if (used >= FETCH_RAW_LIMIT) {
    return { allowed: false, used, remaining: 0, retryAfterMs: Math.max(0, fetchRawCallsAt[0]! - windowStart) };
  }
  fetchRawCallsAt.push(now);
  return { allowed: true, used: used + 1, remaining: FETCH_RAW_LIMIT - used - 1, retryAfterMs: 0 };
}

/** Test-only: clear the limiter window. */
export function resetFetchRawLimiter(): void {
  fetchRawCallsAt.length = 0;
}

/**
 * Per-call output byte cap (hard-task review finding, 2026-07-03): the limiter
 * bounds call COUNT, but one allowed call could still pull an arbitrarily large
 * transcript into the metered window. Cap the delegated payload and say so.
 */
export const FETCH_RAW_MAX_RESULT_CHARS = 32_000;

export function capFetchRawContent(
  content: McpToolResult['content'],
): { content: McpToolResult['content']; truncated: boolean } {
  let budget = FETCH_RAW_MAX_RESULT_CHARS;
  let truncated = false;
  const capped = content.map((block) => {
    if (!('text' in block)) return block;
    if (block.text.length <= budget) {
      budget -= block.text.length;
      return block;
    }
    const kept = block.text.slice(0, Math.max(0, budget));
    budget = 0;
    truncated = true;
    return { ...block, text: `${kept}\n[... fetch_raw output truncated at ${FETCH_RAW_MAX_RESULT_CHARS} chars — narrow with cursor/limit, or use digest ...]` };
  });
  return { content: capped, truncated };
}

// ── Tool definitions ──────────────────────────────────────────────────────────

export const DIGEST_TOOLS: McpTool[] = [
  {
    name: 'digest',
    description:
      'Compress bulk material (logs, test output, a diff, docs, any pasted dump) into a compact actionable summary BEFORE it enters your context. Runs on a fixed-cost model in a fresh read-only session — never the session that produced the material. Prefer this over reading bulk directly whenever the content exceeds a screenful. Example: digest({text: "<10K lines of test output>", repoPath: "/path/to/repo"}) returns sections: What this is / Key facts / Errors (verbatim) / Decisions needed.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The bulk material to digest.' },
        repoPath: { type: 'string', description: 'Repo path for context (registered repo root).' },
      },
      required: ['text', 'repoPath'],
    },
  },
  {
    name: 'fetch_raw',
    description:
      'Rate-limited escape hatch: read the RAW packet transcript when a digest or summary is not trustworthy enough to decide on (security/auth/schema/payment diffs, a suspected summarization error, low confidence). Same shape as a transcript tail. Metered per session — use deliberately, not by default; prefer digest / get_mission_status for routine progress. Example: fetch_raw({packetId: "P1", limit: 50}).',
    inputSchema: {
      type: 'object',
      properties: {
        packetId: { type: 'string', description: 'Packet id whose raw transcript to read.' },
        limit: { type: 'number', description: 'Max events to return (tail). Default 50, cap 200.' },
        cursor: { type: 'number', description: 'Fetch events with seq > cursor instead of the tail.' },
      },
      required: ['packetId'],
    },
  },
];

// ── Handlers ──────────────────────────────────────────────────────────────────

export async function handleDigest(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const text = typeof args.text === 'string' ? args.text : '';
    const repoPath = typeof args.repoPath === 'string' ? args.repoPath.trim() : '';
    if (!text.trim()) return textResult('text is required', true);
    if (!repoPath) return textResult('repoPath is required', true);

    const data = await apiFetch('/api/orchestrator/digest', {
      method: 'POST',
      body: JSON.stringify({ text, repoPath }),
      timeoutMs: 120_000,
    }) as Record<string, unknown>;

    return jsonResult({
      summary: `Digested ~${data.approxInputTokens ?? '?'} tokens → ~${data.approxDigestTokens ?? '?'} tokens${data.truncatedInput ? ' (input truncated)' : ''}`,
      data: {
        digest: data.digest ?? '',
        approxInputTokens: data.approxInputTokens ?? null,
        approxDigestTokens: data.approxDigestTokens ?? null,
        truncatedInput: data.truncatedInput === true,
      },
    });
  } catch (error) {
    console.error(`[mcp-operator] digest failed: ${errorText(error)}`);
    return textResult(`Digest failed: ${errorText(error)}`, true);
  }
}

export async function handleFetchRaw(args: Record<string, unknown>): Promise<McpToolResult> {
  const meter = fetchRawRateCheck();
  if (!meter.allowed) {
    return textResult(
      `fetch_raw window exhausted (${FETCH_RAW_LIMIT} raw reads per ${Math.round(FETCH_RAW_WINDOW_MS / 60_000)} min). `
      + `Retry in ~${Math.ceil(meter.retryAfterMs / 1000)}s, or use digest / get_mission_status / mission_tail for a compact view.`,
      true,
    );
  }

  // Delegate to the same normalized-transcript read o8_packet_transcript uses
  // (default to a tail when neither tail nor cursor was specified), then append
  // the meter so the caller sees its remaining raw-read budget.
  const delegatedArgs: Record<string, unknown> = { ...args };
  if (delegatedArgs.tail === undefined && delegatedArgs.cursor === undefined) delegatedArgs.tail = true;
  if (delegatedArgs.limit === undefined) delegatedArgs.limit = 50;
  const result = await handleTranscript(delegatedArgs);
  const { content } = capFetchRawContent(result.content);
  return {
    ...result,
    content: [
      ...content,
      { type: 'text', text: `fetch_raw meter: ${meter.used}/${FETCH_RAW_LIMIT} used this window (${meter.remaining} remaining).` },
    ],
  };
}
