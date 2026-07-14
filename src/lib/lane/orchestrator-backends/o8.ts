/**
 * o8 orchestrator backend — the FREE conversational surface.
 *
 * Routes an orchestrator turn to the DESKTOP free-chat rail — the branded
 * zero-setup `o8-operator` model behind `/api/v2/proxy/llm` (Gemini Flash with
 * an OpenRouter free fallback, resolved server-side). This is the same rail the
 * llm-chat tab's default model rides, so it works on every desktop install with
 * no cloud-only env (the Vercel AI Gateway path needs CLERK_SECRET_KEY, which by
 * policy never ships to the desktop). It lets the operator exercise the full
 * orchestrator UI — token streaming, transcripts, banners, thread restore —
 * without drawing on any Claude / Codex subscription pool. Replaces the
 * experimental llm-chat tab as the free-test surface (operator ruling
 * 2026-07-12).
 *
 * Founders/paid tier (Gemini 3 Flash, "High") gets the file-editing tool loop:
 * read_file/create_file/edit_file/shell scoped to the SELECTED repo's working
 * tree, executed server-side by the proxy's Google tool loop. Edits land in the
 * working tree and surface in the o8 workspace diff for the operator to review +
 * commit — Composer parity, still governed (the model never commits or merges).
 * The free tier ("Low", OpenRouter chain) stays pure conversational streaming
 * (NO tools) — the free models' tool-calling is unproven and that rail is
 * tools-free. NO orchestrator dispatch, NO MCP on either tier (Q ruling
 * 2026-07-14).
 *
 * Stateless: the proxy holds no server session, so a "session" here is just a
 * deterministic per-repo+thread name used to route WS broadcasts. Prior turns
 * are reconstructed from the persisted thread transcript on every send (the user
 * message is already on disk by the time ws-server calls `sendTurn`).
 *
 * The fetch targets the loopback API base (`getApiBase()`), and ws-server runs
 * on loopback, so the middleware passes it without a bearer token.
 */

import { getEntitlementSync } from '@/lib/entitlement/store';
import { sessionNameForRepo } from '@/lib/lane/orchestrator-session-core';
import { readOrchestratorThreadMessages } from '@/lib/mobile/orchestrator-thread-history';
import { getApiBase } from '@/lib/panel/api-port';
import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';
import type {
  OrchestratorBackend,
  OrchestratorSessionInfo,
  OrchestratorTurnOptions,
} from './types';

/**
 * Conversational framing sent as the system message (the proxy folds any
 * `role: 'system'` message into its system context). Tier-specific per the
 * prompt lab A/B (2026-07-12, scratchpad prompt-lab/): the recursive
 * two-angle pass fixed the free model's hallucination trap outright (3.5 →
 * 8.7) at zero latency cost, but the skills-fused principles layer only
 * helps the STRONGER founders model — on the small model it nudged answers
 * back toward overclaiming, and on Gemini the recursive pass alone caused
 * confident fabricated NEGATIVES until the principles layer grounded it.
 * So: Low (free rail) = base + recursive; High (founders rail) = base +
 * recursive + principles. Don't merge them.
 */
const O8_PROMPT_BASE = [
  'Answer concisely and helpfully.',
  'You are a chat surface only in this mode: you cannot dispatch agents, run tools,',
  'edit files, or drive the repo. If the operator asks for real repo work, say plainly',
  'that the o8 model is conversational only and that they can switch the composer',
  'to Claude or Codex to dispatch actual agents. Never claim you dispatched or ran anything.',
].join(' ');

// Founders/tool-capable base — used ONLY when the file-editing tools are actually
// attached (paid plan, High rail). The Composer contract: DO the work by calling
// the tools, don't paste code and ask the operator to save it; edits land in the
// working tree and surface in the o8 workspace diff for operator review.
const O8_PROMPT_BASE_CAPABLE = [
  'Answer concisely and helpfully.',
  'You have file tools attached and can act on the scoped repository DIRECTLY: read',
  'files, create new files, and edit existing files. When the operator asks you to',
  'build, create, edit, or fix something, DO IT by calling the attached tools — never',
  'paste a code block and tell them to save it themselves. Match each tool\'s schema',
  'exactly. Your changes are written to the working tree and surface in the o8 workspace',
  'diff for the operator to review and commit; you never commit, push, or merge anything',
  'yourself — GitHub stays the operator\'s action. Confirm from the tool result before',
  'claiming a file was written, and keep prose brief around the actions.',
].join(' ');

const O8_PROMPT_RECURSIVE = [
  'Before answering anything non-trivial, make two silent passes from two different angles:',
  'first as a builder (what is the direct answer / solution?), then as a skeptic (what did',
  'the first pass miss, assume, or get wrong? what would break it?). Reconcile the two',
  'passes into one answer. For any question about o8 itself, do a final accuracy pass:',
  'every feature you name must come from the concepts you were given — if it isn\'t there,',
  'say you\'re not certain instead of inventing it. Keep all of this reasoning silent;',
  'deliver only the reconciled answer, concise and confident.',
].join(' ');

const O8_PROMPT_PRINCIPLES = [
  'Working principles: Lead with the answer — the first sentence should resolve the',
  'question, detail after. Simplicity first — recommend the minimum change that solves the',
  'problem, never speculative flexibility. Be surgical — when suggesting changes, touch',
  'only what the request requires. Verify the real path — a suggestion isn\'t done until',
  'you\'ve explained how the user confirms it actually worked. Say plainly what you don\'t',
  'know or can\'t do; never fake certainty or invent capabilities.',
].join(' ');

// Grounding block — the recursive accuracy pass needs real concepts to check
// feature claims against, or it has nothing to be honest WITH.
const O8_CONCEPTS = [
  'o8 concepts: the operator dispatches MISSIONS which become PACKETS (units of agent',
  'work) running in isolated git worktrees called LANES; every diff is REVIEWED by the',
  'operator before APPROVE-AND-MERGE lands it on main. The composer\'s model picker',
  'chooses which AI drives the orchestrator.',
].join(' ');

// Tuned-v2 slot (model shootout rounds 2–2b, scripts/eval-o8-model.mjs +
// scratchpad/o8-model-eval.md): grounding + tool discipline + answer style.
// Measured on the High envelope only — markdown restraint alone lifted domain
// answers from 0-5/6 to 5-6/6 across every model tested, and the current
// founders model (gemini-2.5-flash) went 1.56 → 2.00 with this appended. The
// tool sections are written conditionally ("if attached") so they are inert on
// today's tools-free rail and ready for a tool-capable surface. High tier only:
// the prompt-lab A/B showed extra instruction layers push the small free model
// back toward overclaiming.
const O8_PROMPT_TUNED_SLOT = `Stay in the o8 role. Never describe yourself as a generic AI assistant or claim capabilities the current surface does not provide.

Grounding:
1. Claim only what the conversation, supplied o8 context, or tool results support. Never fill gaps with plausible-sounding repo details.
2. The shipping chat rail has no tools. If no tool schemas are attached, stay conversational and direct the operator to Claude or Codex for repo actions.
3. An attached tool schema switches that request into tool-capable mode. Honor direct instructions to use a matching attached tool; do not mention the conversational-only boundary in that mode. Only the named tools exist, and their presence is not permission to invent any other action.
4. If ask_brain is attached, consult it before repo-specific or o8-behavior claims. Skip it for small talk, general programming knowledge, and facts already established in the supplied context. If evidence is unavailable, say "I'm not sure" and name what would verify it.
5. When ask_brain is attached for a repo-specific question, the first response must be that tool call. Never answer such a question from general memory instead.

Tool discipline:
1. Answer directly when the request is small talk, general knowledge, or fully answered by supplied context.
2. Call an attached tool when fresh repo evidence is required or the user explicitly asks for an action that tool supports. If a tool is required, emit the call immediately without narrating it first.
3. Follow the requested tool sequence. Match schemas exactly: correct types and nesting, no invented fields, and no stringified numbers. If every schema-required field is supplied, call the tool; do not ask for fields the schema does not define.
4. After a tool result, use it. Do not repeat the same lookup or ignore returned evidence.
5. Never imply a tool ran when it did not, and never claim an action succeeded without a confirming result.

Answer style:
- Default to plain prose in 2-5 sentences and at most about 120 words unless the operator asks for depth.
- Do not use markdown headings, tables, or decorative formatting unless asked. Use bullets only when a real list materially improves clarity.
- Lead with the answer, omit throat-clearing, and do not restate the request.
- A strict requested output format overrides every style preference. Return only that format, with no preface or afterword.`;

/**
 * Tier + tool-access decision for an o8 turn. Pure + exported so the
 * security-relevant invariant is testable through the real entry point: the
 * FREE tier must never be granted file tools. Mirrors the proxy's own
 * Gemini-routing gate (`paidPlan && !wantsLow`, route.ts) so the prompt we send
 * matches whether tools will actually be attached — the free OpenRouter chain
 * is tools-free, so promising editing there would make the model hallucinate
 * edits. Defense-in-depth: even if this returned the wrong answer, the proxy
 * still fail-closes a free plan to the tools-free chain.
 */
export function o8TierAccess(
  paidPlan: boolean,
  thinkingEffort: OrchestratorTurnOptions['thinkingEffort'],
  hasRepo: boolean,
): { tier: 'low' | 'high'; toolsEnabled: boolean } {
  const tier: 'low' | 'high' = thinkingEffort === 'high'
    ? 'high'
    : thinkingEffort === 'low'
      ? 'low'
      : paidPlan ? 'high' : 'low';
  // Both free and founders edit files (Q ruling 2026-07-14) — tool access gates
  // on a scoped repo, NOT the plan. `paidPlan` only picks the default rail/tier.
  // The proxy independently fail-closes when no repo resolves, so this is the
  // client half of a two-sided gate.
  const toolsEnabled = hasRepo;
  return { tier, toolsEnabled };
}

export function o8SystemPrompt(tier: 'low' | 'high', toolsEnabled: boolean, repoName = ''): string {
  const identity = toolsEnabled
    ? 'You are o8 — the model inside the o8 control plane, able to chat and edit the repo directly.'
    : tier === 'high'
      ? 'You are o8 — the conversational model inside the o8 control plane.'
      : 'You are o8 — the free conversational model inside the o8 control plane.';
  const base = toolsEnabled ? O8_PROMPT_BASE_CAPABLE : O8_PROMPT_BASE;
  // Repo-awareness (Q ruling 2026-07-14): name the repo the turn is scoped to so
  // the model can orient itself — "orchestrator light". With tools it should read
  // real files rather than guess.
  const repoLine = toolsEnabled && repoName
    ? `You are scoped to the "${repoName}" repository; read real files with the file tools before making repo-specific claims — never invent file contents.`
    : '';
  const parts = tier === 'high'
    ? [identity, base, repoLine, O8_PROMPT_RECURSIVE, O8_PROMPT_PRINCIPLES].filter(Boolean)
    : [identity, base, repoLine, O8_PROMPT_RECURSIVE].filter(Boolean);
  const envelope = `${parts.join(' ')}\n\n${O8_CONCEPTS}`;
  return tier === 'high' ? `${envelope}\n\n${O8_PROMPT_TUNED_SLOT}` : envelope;
}

type ProxyMessage = { role: 'system' | 'user' | 'assistant'; content: string };

/** Deterministic-name registry so `peekSession` mirrors an ensured session. */
const ensured = new Set<string>();

function o8SessionName(repoPath: string, threadId?: string | null): string {
  return sessionNameForRepo('o8-free-orchestrator', repoPath, threadId);
}

async function sendToO8Orchestrator(
  sessionName: string,
  repoPath: string,
  message: string,
  onEvent: (event: OrchestratorEvent) => void,
  options: OrchestratorTurnOptions,
): Promise<void> {
  const done = () => onEvent({ type: 'done', sessionId: sessionName, cost: 0 });

  // ws-server appends the user message to the thread transcript BEFORE calling
  // the backend, so the reconstructed history's last entry IS this turn. Use it
  // as-is; fall back to the raw message param only for non-thread-backed turns
  // (empty history) — never both, so the current turn is never doubled.
  const prior = readOrchestratorThreadMessages(options.threadId);
  const history: ProxyMessage[] =
    prior.length > 0 && prior[prior.length - 1].role === 'user'
      ? prior
      : [...prior, { role: 'user', content: message }];
  // Tier mirrors the proxy's own gate: explicit effort wins, absent = plan
  // auto (founders High, free Low). The prompt must match the rail the proxy
  // will actually pick, so both resolve the same way.
  const paidPlan = getEntitlementSync().plan !== 'free';
  const hasRepo = Boolean(repoPath && repoPath.trim());
  const repoName = hasRepo ? (repoPath.split('/').filter(Boolean).pop() ?? '') : '';
  const { tier, toolsEnabled } = o8TierAccess(paidPlan, options.thinkingEffort, hasRepo);
  const messages: ProxyMessage[] = [{ role: 'system', content: o8SystemPrompt(tier, toolsEnabled, repoName) }, ...history];

  let response: Response;
  try {
    response = await fetch(`${getApiBase()}/api/v2/proxy/llm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'o8-operator',
        provider: 'operator',
        messages,
        // Founders rail edits files directly via the proxy's server-side Google
        // tool loop; the free rail stays tools-off. `repoPath` scopes write_file/
        // edit_file/run_terminal_command to THIS repo's working tree (the proxy
        // resolves it against the registry and sandboxes writes within it). Only
        // send it when tools are on, so the free path is unchanged.
        disableTools: !toolsEnabled,
        ...(toolsEnabled ? { repoPath } : {}),
        // Tier gate (Q ruling 2026-07-12): High = founders rail, Low = free
        // rail. Absent = server auto by plan. The proxy enforces the plan
        // either way — this is a request, not an entitlement.
        ...(options.thinkingEffort
          ? { thinkingEffort: options.thinkingEffort === 'high' ? 'high' : 'low' }
          : {}),
      }),
      signal: options.signal,
    });
  } catch (err) {
    // Reaching the proxy failed (or a user abort landed before the response). A
    // clean stop is not an error line; anything else surfaces as one.
    if (!options.signal?.aborted) {
      onEvent({
        type: 'error',
        error: `The free o8 model couldn't reach the model service: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    done();
    return;
  }

  // Non-2xx from the proxy is a JSON error body (`{ error }`), not an SSE stream.
  if (!response.ok || !response.body) {
    let detail = `HTTP ${response.status}`;
    try {
      const payload = await response.json() as { error?: unknown };
      if (typeof payload?.error === 'string' && payload.error.trim()) detail = payload.error;
    } catch {
      // Non-JSON body — keep the status-code detail.
    }
    onEvent({ type: 'error', error: `The free o8 model is unavailable: ${detail}` });
    done();
    return;
  }

  // SSE frames: `data: {json}\n\n`, terminated by `data: [DONE]`. We map
  // `content`→text, `thinking`→thinking, and the founders tool loop's
  // `tool_use`/`tool_result` frames → the matching OrchestratorEvents so file
  // edits render as tool pills + the "edited files" card in the transcript.
  // `error`→error; `usage` / `fallback` / `sources` carry no transcript payload
  // and are skipped (cost is unmetered on the operator rail).
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done: streamDone, value } = await reader.read();
      if (streamDone) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]' || data.trim() === '') continue;
        let parsed: {
          type?: string;
          text?: unknown;
          message?: unknown;
          toolName?: unknown;
          toolCallId?: unknown;
          arguments?: unknown;
          output?: unknown;
          status?: unknown;
        };
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }
        if (parsed.type === 'content' && typeof parsed.text === 'string') {
          if (parsed.text) onEvent({ type: 'text', text: parsed.text });
        } else if (parsed.type === 'thinking' && typeof parsed.text === 'string') {
          if (parsed.text) onEvent({ type: 'thinking', text: parsed.text });
        } else if (parsed.type === 'tool_use' && typeof parsed.toolName === 'string') {
          onEvent({
            type: 'tool_use',
            id: typeof parsed.toolCallId === 'string' ? parsed.toolCallId : null,
            name: parsed.toolName,
            input: parsed.arguments ?? null,
          });
        } else if (parsed.type === 'tool_result' && typeof parsed.toolName === 'string') {
          const output = typeof parsed.output === 'string' ? parsed.output : '';
          onEvent({
            type: 'tool_result',
            id: typeof parsed.toolCallId === 'string' ? parsed.toolCallId : null,
            name: parsed.toolName,
            output,
            ...(parsed.status === 'error' || /^\s*error/i.test(output) ? { isError: true } : {}),
          });
        } else if (parsed.type === 'error') {
          onEvent({
            type: 'error',
            error: typeof parsed.message === 'string' && parsed.message.trim()
              ? parsed.message
              : 'The free o8 model hit an error.',
          });
        }
      }
    }
    done();
  } catch (err) {
    // A user interrupt aborts the read — a clean stop, no error line. Any other
    // failure surfaces as a system line. Either way emit the terminal `done` so
    // the client "Working" latch releases (mirrors openclaw's error→done order).
    if (!options.signal?.aborted) {
      onEvent({
        type: 'error',
        error: `The free o8 model hit an error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    done();
  }
}

export const o8Backend: OrchestratorBackend = {
  id: 'o8',
  label: 'o8',
  peekSession(repoPath, _agent, threadId): OrchestratorSessionInfo | null {
    const sessionName = o8SessionName(repoPath, threadId);
    return ensured.has(sessionName) ? { sessionName, status: 'ready' } : null;
  },
  ensureSession(repoPath, _agent, threadId): OrchestratorSessionInfo {
    const sessionName = o8SessionName(repoPath, threadId);
    ensured.add(sessionName);
    return { sessionName, status: 'ready' };
  },
  sendTurn(repoPath, message, onEvent, options) {
    const sessionName = o8SessionName(repoPath, options?.threadId);
    ensured.add(sessionName);
    return sendToO8Orchestrator(sessionName, repoPath, message, onEvent, options ?? {});
  },
};
