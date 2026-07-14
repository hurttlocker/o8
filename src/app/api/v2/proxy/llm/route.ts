export const dynamic = 'force-dynamic';

import { NextRequest } from 'next/server';
import { createApproval } from '@/lib/approvals/store';
import { evaluatePolicy, buildPolicyContext } from '@/lib/approvals/policies';
import { withOptionalAuth, type AuthContext } from '@/lib/auth/middleware';
import { logUsage, getCurrentPeriodCost } from '@/lib/db/usage';
import { getEntitlementSync } from '@/lib/entitlement/store';
import {
  parseAnthropicStopMetadata,
  resolveAnthropicTaskBudget,
  type AnthropicStopMetadata,
  type ResolvedAnthropicTaskBudget,
} from '@/lib/llm/anthropic-task-budget';
import { getWorkspaceContext, buildSystemPrompt } from '@/lib/llm/context';
import { getPersonalizedChatFtuxPayload } from '@/lib/llm/personalized-chat-ftux';
import { anthropicPricingForModel } from '@/lib/llm/pricing';
import { LLM_REPO_PATH_HEADER } from '@/lib/llm/repo-scope';
import { executeTool, type ToolResult } from '@/lib/llm/tools';
import { resolvePromptCachingEnabledSync } from '@/lib/operator/defaults';
import { resolveRepoPathFromRegistry } from '@/lib/repos/repo-path-registry';
import { isThinkingEffort, type ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import {
  computeCost,
  isSupportedProvider,
  OPERATOR_FREE_OPENROUTER_MODELS,
  OPERATOR_GEMINI_MODEL,
  OPERATOR_GEMINI_ROLLBACK_MODEL,
  PROVIDERS,
  resolveApiKey,
  type Message,
} from './provider-config';
import { resolveOpenRouterRoute } from '@/lib/cortex/qa/llm/inference-route';
import { createGoogleToolResponseStream } from './google-native-tools';
import { streamOpenRouterFallback } from './operator-fallback';

const UPSTREAM_TIMEOUT_MS = 30_000;
const TOKENS_PER_MILLION = 1_000_000;
const ANTHROPIC_CACHE_READ_MULTIPLIER = 0.1;
const ANTHROPIC_CACHE_WRITE_MULTIPLIER = 1.25;

type AnthropicUsageTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

function jsonError(message: string, status: number) {
  return new Response(
    JSON.stringify({ error: message }),
    { status, headers: { 'Content-Type': 'application/json' } },
  );
}

// ── o8 Operator abuse limiter ────────────────────────────────────────────────
// The operator rail is unmetered for every plan (Q ruling 2026-07-12:
// "founders don't have any usage… but we should have rate limits for abuse").
// This is an anti-runaway guard for the single-operator desktop, not
// multi-tenant fairness: generous enough that no human conversation ever
// trips it, tight enough that a looping script can't torch the OpenRouter
// key's free-tier standing or the founder Gemini key. In-memory by design —
// a process restart resetting the window is fine for an abuse guard.
const OPERATOR_LIMIT_PER_MINUTE = 20;
const OPERATOR_LIMIT_PER_DAY = 500;
const operatorCallTimestamps: number[] = [];

function checkOperatorAbuseLimit(): Response | null {
  const now = Date.now();
  const dayAgo = now - 24 * 60 * 60_000;
  while (operatorCallTimestamps.length > 0 && operatorCallTimestamps[0] < dayAgo) {
    operatorCallTimestamps.shift();
  }
  const minuteAgo = now - 60_000;
  const lastMinute = operatorCallTimestamps.filter((t) => t >= minuteAgo).length;
  if (lastMinute >= OPERATOR_LIMIT_PER_MINUTE) {
    return jsonError('o8 model rate limit: too many requests this minute. Wait a moment and try again.', 429);
  }
  if (operatorCallTimestamps.length >= OPERATOR_LIMIT_PER_DAY) {
    return jsonError('o8 model rate limit: daily request cap reached. Resets over the next 24 hours.', 429);
  }
  operatorCallTimestamps.push(now);
  return null;
}

function approvalTitleForTool(toolName: string) {
  if (toolName === 'run_terminal_command') return 'Run terminal command';
  if (toolName === 'write_file') return 'Write file';
  if (toolName === 'edit_file') return 'Edit file';
  if (toolName === 'delete_file') return 'Delete file';
  if (toolName === 'create_github_issue') return 'Create GitHub issue';
  if (toolName === 'create_pull_request') return 'Create pull request';
  if (toolName === 'lane_command') return 'Lane command';
  return `Execute ${toolName}`;
}

async function fetchWithTimeout(
  url: string,
  headers: Record<string, string>,
  body: string,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    return await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function asFiniteTokenCount(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function computeUsageCost(
  provider: string,
  model: string,
  usage: AnthropicUsageTotals,
) {
  if (provider !== 'anthropic') {
    return computeCost(model, usage.inputTokens, usage.outputTokens);
  }

  const pricing = anthropicPricingForModel(model);
  if (!pricing) {
    return computeCost(model, usage.inputTokens, usage.outputTokens);
  }

  return (
    usage.inputTokens * pricing.input
    + usage.outputTokens * pricing.output
    + usage.cacheReadTokens * pricing.input * ANTHROPIC_CACHE_READ_MULTIPLIER
    + usage.cacheWriteTokens * pricing.input * ANTHROPIC_CACHE_WRITE_MULTIPLIER
  ) / TOKENS_PER_MILLION;
}

function parseRequestedThinkingEffort(value: unknown): ThinkingEffort | null {
  return isThinkingEffort(value) ? value : null;
}

function supportsAnthropicAdaptiveThinking(model: string): boolean {
  const normalizedModel = model.trim().toLowerCase();
  return normalizedModel.includes('claude-opus-4-8')
    || normalizedModel.includes('claude-opus-4-7')
    || normalizedModel.includes('claude-opus-4-6')
    || normalizedModel.includes('claude-sonnet-5')
    || normalizedModel.includes('claude-sonnet-4-6')
    || normalizedModel.includes('claude-mythos-preview');
}

/**
 * Map an explicit ThinkingEffort tier (low/medium/high/max/xhigh) to an Anthropic
 * `budget_tokens` value. `adaptive` returns null because the model self-regulates.
 */
function thinkingBudgetForEffort(effort: ThinkingEffort | null): number | null {
  switch (effort) {
    case 'low':
      return 4_000;
    case 'medium':
      return 10_000;
    case 'high':
      return 24_000;
    case 'max':
      return 48_000;
    case 'xhigh':
      return 64_000;
    case 'adaptive':
    default:
      return null;
  }
}

function applyAnthropicThinkingConfig(
  upstreamBody: Record<string, unknown>,
  model: string,
  requestedThinkingEffort: ThinkingEffort | null,
) {
  if (requestedThinkingEffort === 'adaptive') {
    delete upstreamBody.thinking;
    return;
  }
  if (requestedThinkingEffort !== null) {
    // Explicit effort tier — buildBody already wired the matching budget_tokens via
    // ProviderBuildOptions; nothing further to do here.
    return;
  }
  if (!supportsAnthropicAdaptiveThinking(model)) {
    return;
  }
  const maxTokens = typeof upstreamBody.max_tokens === 'number' && Number.isFinite(upstreamBody.max_tokens)
    ? upstreamBody.max_tokens
    : 0;
  upstreamBody.max_tokens = Math.max(maxTokens, 16_384);
  upstreamBody.thinking = {
    type: 'adaptive',
    display: 'summarized',
  };
}

function parseAnthropicStreamUsage(line: string) {
  if (!line.startsWith('data: ')) return null;

  try {
    const payload = JSON.parse(line.slice(6).trim()) as {
      usage?: Record<string, unknown>;
      message?: { usage?: Record<string, unknown> };
    };
    const usage = payload.message?.usage ?? payload.usage;
    if (!usage) return null;
    return {
      cacheReadTokens: asFiniteTokenCount(usage.cache_read_input_tokens),
      cacheWriteTokens: asFiniteTokenCount(usage.cache_creation_input_tokens),
    };
  } catch {
    return null;
  }
}

function withAnthropicPromptCaching(body: Record<string, unknown>, provider: string) {
  if (provider !== 'anthropic') {
    return body;
  }
  if (!resolvePromptCachingEnabledSync()) {
    return body;
  }

  const nextBody = { ...body };
  if (typeof nextBody.system === 'string' && nextBody.system.trim()) {
    nextBody.system = [{
      type: 'text',
      text: nextBody.system,
      cache_control: { type: 'ephemeral' as const },
    }];
  }
  return nextBody;
}

function mergeAnthropicStopState(
  current: AnthropicStopMetadata | null,
  next: AnthropicStopMetadata | null,
): AnthropicStopMetadata | null {
  if (!current) return next;
  if (!next) return current;

  return {
    stopReason: next.stopReason ?? current.stopReason,
    ...(next.stopSequence !== undefined
      ? { stopSequence: next.stopSequence }
      : current.stopSequence !== undefined
        ? { stopSequence: current.stopSequence }
        : {}),
  };
}

function buildUsageEvent(
  provider: string,
  model: string,
  usage: AnthropicUsageTotals,
  options?: {
    stopMetadata?: AnthropicStopMetadata | null;
    taskBudget?: ResolvedAnthropicTaskBudget | null;
  },
) {
  const event: Record<string, unknown> = {
    type: 'usage',
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costUsd: computeUsageCost(provider, model, usage),
  };

  if (provider === 'anthropic') {
    event.cacheReadTokens = usage.cacheReadTokens;
    event.cacheWriteTokens = usage.cacheWriteTokens;
    event.usage = {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cache_read_input_tokens: usage.cacheReadTokens,
      cache_creation_input_tokens: usage.cacheWriteTokens,
    };
    if (options?.stopMetadata?.stopReason) {
      event.stopReason = options.stopMetadata.stopReason;
    }
    if (options?.stopMetadata?.stopSequence !== undefined) {
      event.stopSequence = options.stopMetadata.stopSequence;
    }
    if (options?.taskBudget) {
      event.taskBudget = options.taskBudget.taskBudget;
      event.taskBudgetSource = options.taskBudget.source;
      if (options.taskBudget.phase) {
        event.taskPhase = options.taskBudget.phase;
      }
    }
  }

  return event;
}

export const POST = withOptionalAuth(async (request: NextRequest, auth: AuthContext | null) => {
  const body = await request.json().catch(() => null);
  if (!body?.model || !body?.provider || !Array.isArray(body?.messages)) {
    return jsonError('model, provider, and messages are required', 400);
  }

  const {
    model,
    provider,
    messages: rawMessages,
    approvedTools: approvedToolsList,
    disableTools,
    repoPath: rawRepoPath,
    toolOverrides: rawToolOverrides,
    thinkingEffort: rawThinkingEffort,
  } = body as {
    model: string;
    provider: string;
    messages: Message[];
    approvedTools?: string[];
    disableTools?: boolean;
    repoPath?: string;
    toolOverrides?: Record<string, Record<string, unknown>>;
    thinkingEffort?: ThinkingEffort;
  };
  const requestedThinkingEffort = parseRequestedThinkingEffort(rawThinkingEffort);

  if (!isSupportedProvider(provider)) {
    return jsonError(`Unsupported provider: ${provider}`, 400);
  }

  const anthropicTaskBudgetResult = provider === 'anthropic'
    ? resolveAnthropicTaskBudget(body as Record<string, unknown>)
    : { value: null as ResolvedAnthropicTaskBudget | null };
  if (anthropicTaskBudgetResult.error) {
    return jsonError(anthropicTaskBudgetResult.error, 400);
  }
  const anthropicTaskBudget = anthropicTaskBudgetResult.value;

  const approvedTools = new Set(approvedToolsList ?? []);
  const toolOverrides = rawToolOverrides ?? {};
  const tabId = request.headers.get('x-tab-id')?.trim() || '';
  const bodyRepoPath = typeof rawRepoPath === 'string' ? rawRepoPath.trim() : '';
  if (rawRepoPath != null && typeof rawRepoPath !== 'string') {
    return jsonError('repoPath must be a string', 400);
  }
  const headerRepoPath = request.headers.get(LLM_REPO_PATH_HEADER)?.trim() || '';
  const requestedRepoPath = bodyRepoPath || headerRepoPath;
  let effectiveRepoRoot = process.cwd();
  // Whether effectiveRepoRoot is a REAL registered repo vs the process.cwd()
  // fallback. Tool writes must never target cwd (the app's own dir) — gate on
  // this before attaching any file tools (2026-07-14 adversarial review).
  let repoResolved = false;
  if (requestedRepoPath) {
    const resolvedRepo = await resolveRepoPathFromRegistry(requestedRepoPath);
    if (!resolvedRepo.ok) {
      return jsonError(resolvedRepo.message, resolvedRepo.status);
    }
    effectiveRepoRoot = resolvedRepo.repoRoot;
    repoResolved = true;
  }
  const nonSystemMessages = rawMessages.filter((message) => message.role !== 'system');
  const priorSystemMessages = rawMessages
    .filter((message) => message.role === 'system')
    .map((message) => message.content.trim())
    .filter(Boolean);
  const assistantMessageCount = nonSystemMessages.filter((message) => message.role === 'assistant').length;
  const userMessageCount = nonSystemMessages.filter((message) => message.role === 'user').length;
  const isFreshChatTurn = assistantMessageCount === 0 && userMessageCount <= 1;

  let systemPrompt = buildSystemPrompt(getWorkspaceContext(effectiveRepoRoot));

  const lastUserMsg = [...nonSystemMessages].reverse().find((message) => message.role === 'user');

  if (isFreshChatTurn) {
    try {
      const ftux = await getPersonalizedChatFtuxPayload({
        userName: auth?.user.name,
        scopedRepoRoot: effectiveRepoRoot,
      });
      if (ftux.systemContext.trim()) {
        systemPrompt += `\n\n${ftux.systemContext}`;
      }
    } catch (error) {
      console.warn('[llm-proxy] Failed to load fresh-chat FTUX context:', error);
    }
  }

  if (priorSystemMessages.length > 0) {
    systemPrompt += `\n\n${priorSystemMessages.join('\n\n')}`;
  }

  const messages: Message[] = [{ role: 'system', content: systemPrompt }, ...nonSystemMessages];

  // The paid-plan budget gate is skipped while "View as Free" (#1517) is active,
  // so the effective-free experience isn't metered against a paid budget. The
  // getEntitlementSync().plan read applies the view-as min-clamp; the auth.user
  // short-circuit keeps it off the hot path for genuine free users.
  if (auth?.user && auth.user.plan !== 'free' && getEntitlementSync().plan !== 'free') {
    const spent = getCurrentPeriodCost(auth.user.id);
    const budget = auth.user.tokenBudgetUsd;
    if (budget != null && spent >= budget) {
      return jsonError('Monthly token budget exceeded. Upgrade your plan or add a BYOK key.', 402);
    }
  }

  // o8 Operator — the branded zero-setup model, plan-gated (Q ruling
  // 2026-07-12): founders/paid auto-ride Gemini Flash ("High"); the free plan
  // auto-rides the $0 OpenRouter chain ("Low" — nemotron won the bake-off,
  // gpt-oss-120b:free is the safety net, so o8 ALWAYS has a model). The tier
  // arrives as thinkingEffort but is SERVER-ENFORCED: a free client asking for
  // high still gets the free chain (fail-closed). Founders draw no metered
  // usage; the abuse limiter below guards the rail against runaway loops.
  if (provider === 'operator') {
    const abuseError = checkOperatorAbuseLimit();
    if (abuseError) return abuseError;

    const geminiKey = process.env.GOOGLE_AI_API_KEY ?? null;
    const openRouterKey = process.env.OPENROUTER_API_KEY ?? null;
    // Founder/paid managed-inference route (the zero-setup perk): the same
    // `/v1/inference` proxy the Brain uses, verified to stream OpenRouter-format
    // SSE for the free chain. Lets a signed-in founder run the o8 model with NO
    // local keys — the packaged app has none, which is why the model was dead
    // on every real install (report BCJBBJ). Only take the proxy route here;
    // local/BYO-key routes are handled by the env-key paths below.
    const inferenceRoute = await resolveOpenRouterRoute().catch(() => null);
    const operatorProxy = inferenceRoute?.via === 'proxy'
      ? { url: inferenceRoute.url, headers: inferenceRoute.headers }
      : null;
    const paidPlan = getEntitlementSync().plan !== 'free';
    // Absent tier = auto: founders default High (Gemini), free defaults Low.
    const wantsLow = requestedThinkingEffort === 'low';
    let geminiQuotaExhausted = false;

    // o8-model file editing (Composer parity). RESTRICTED tool subset — file
    // ops only, NO shell/github (an adversarial review found a github `pr merge`
    // path). Tools attach only when the caller asked for them AND a real repo
    // resolved, so writes never target the app's own cwd.
    const operatorToolNames = ['read_file', 'create_file', 'edit_file'];
    const operatorToolsAllowed = !disableTools && repoResolved;
    const operatorDisableTools = !operatorToolsAllowed;
    const operatorScopedRepoRoot = operatorToolsAllowed ? effectiveRepoRoot : null;

    if (paidPlan && !wantsLow && geminiKey) {
      // Primary then rollback, BOTH through Gemini (Q ruling 2026-07-13):
      // the primary is a preview id Google can re-point or retire, so any
      // failure on it — not just quota — gets one retry on the proven
      // rollback model before the free chain is even considered.
      let lastGeminiResponse: Response | null = null;
      for (const geminiModel of [OPERATOR_GEMINI_MODEL, OPERATOR_GEMINI_ROLLBACK_MODEL]) {
        const geminiResponse = await createGoogleToolResponseStream({
          apiKey: geminiKey,
          auth,
          disableTools: operatorDisableTools,
          lastUserContent: lastUserMsg?.content,
          messages,
          model: geminiModel,
          scopedRepoRoot: operatorScopedRepoRoot,
          tabId,
          toolNames: operatorToolNames,
        });
        if (geminiResponse.ok) return geminiResponse;
        lastGeminiResponse = geminiResponse;
      }
      const status = lastGeminiResponse?.status ?? 503;
      if (status !== 429 && status !== 503 && status !== 402) {
        return lastGeminiResponse ?? jsonError('o8 Operator unavailable.', 503);
      }
      // Quota/exhaustion on the whole Gemini rail — drop into the free chain.
      geminiQuotaExhausted = true;
    }

    // Free chain — runs when there's ANY way to reach it: a founder's managed
    // proxy (zero keys), or a direct OpenRouter key (dev box / BYOK). The proxy
    // wins when present; `endpoint` overrides the destination so `apiKey` is
    // unused on that path.
    if (operatorProxy || openRouterKey) {
      let lastFailure: Response | null = null;
      for (const freeModel of OPERATOR_FREE_OPENROUTER_MODELS) {
        const response = await streamOpenRouterFallback({
          apiKey: openRouterKey ?? '',
          endpoint: operatorProxy,
          messages,
          model: freeModel,
          auth,
          // File-editing tools for free + founders-low (Composer parity). The
          // fallback filters to file ops only (no shell/github) and sandboxes
          // to the repo — same gate as the Gemini rail.
          enableTools: operatorToolsAllowed,
          scopedRepoRoot: operatorScopedRepoRoot,
          // Degradation banner only for a founder whose Gemini quota died —
          // the free plan rides this chain by design, no banner.
          notice: geminiQuotaExhausted
            ? {
              originalModel: OPERATOR_GEMINI_MODEL,
              originalModelLabel: 'Gemini 3 Flash',
              reason: 'Gemini quota exhausted — using the free chain',
            }
            : null,
        });
        if (response.ok) return response;
        lastFailure = response;
      }
      if (!geminiKey) {
        return lastFailure ?? jsonError('The o8 model is temporarily unavailable — every free model failed to respond. Try again in a moment.', 503);
      }
    }

    // Last resort so o8 always answers when any key exists — a free install
    // with only a Google key beats a dead composer. Rides the ROLLBACK model
    // (stable id, proven record) so this path never depends on a preview id.
    if (geminiKey) {
      return createGoogleToolResponseStream({
        apiKey: geminiKey,
        auth,
        disableTools: operatorDisableTools,
        lastUserContent: lastUserMsg?.content,
        messages,
        model: OPERATOR_GEMINI_ROLLBACK_MODEL,
        scopedRepoRoot: operatorScopedRepoRoot,
        tabId,
        toolNames: operatorToolNames,
      });
    }

    // No managed proxy (not signed in as a founder) and no local key. The o8
    // model needs an inference source — never leak env-var names to the user
    // (report BCJBBJ showed a raw "set OPENROUTER_API_KEY…" dev string).
    return jsonError(
      'The free o8 model needs a connection: sign in with your founder account to use o8-managed inference, or add your own model key in Settings → Keys.',
      503,
    );
  }

  const apiKey = resolveApiKey(provider);
  if (!apiKey) {
    const envKey = provider === 'google' ? 'GOOGLE_AI_API_KEY' : PROVIDERS[provider].envKey;
    return jsonError(`No API key configured for ${provider}. Set ${envKey} in your environment.`, 400);
  }

  if (provider === 'google') {
    return createGoogleToolResponseStream({
      apiKey,
      auth,
      disableTools,
      lastUserContent: lastUserMsg?.content,
      messages,
      model,
      scopedRepoRoot: effectiveRepoRoot,
      tabId,
    });
  }

  const config = PROVIDERS[provider];
  const headers = config.buildHeaders(apiKey);
  const cacheBreakpointEnabled = provider === 'anthropic' ? resolvePromptCachingEnabledSync() : false;
  const explicitThinkingBudget = provider === 'anthropic'
    ? thinkingBudgetForEffort(requestedThinkingEffort)
    : null;
  const buildUpstreamBody = (requestMessages: Message[]) => {
    const upstreamBody = withAnthropicPromptCaching(
      config.buildBody(model, requestMessages, {
        cacheBreakpoint: cacheBreakpointEnabled,
        thinkingBudgetTokens: explicitThinkingBudget ?? undefined,
      }) as Record<string, unknown>,
      provider,
    );
    if (provider === 'anthropic') {
      applyAnthropicThinkingConfig(upstreamBody, model, requestedThinkingEffort);
    }
    if (provider === 'anthropic' && anthropicTaskBudget) {
      upstreamBody.task_budget = anthropicTaskBudget.taskBudget;
      console.info(
        `[llm-proxy] Anthropic task_budget=${anthropicTaskBudget.taskBudget}`
        + `${anthropicTaskBudget.phase ? ` phase=${anthropicTaskBudget.phase}` : ''}`
        + ` source=${anthropicTaskBudget.source}`,
      );
    }
    if (disableTools) {
      delete upstreamBody.tools;
    }
    return upstreamBody;
  };
  const upstreamBody = buildUpstreamBody(messages);

  let upstream: globalThis.Response;
  try {
    upstream = await fetchWithTimeout(config.url, headers, JSON.stringify(upstreamBody));
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : 'Proxy request failed', 502);
  }

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => 'Unknown error');
    return jsonError(`${provider} API error (${upstream.status}): ${errText.slice(0, 500)}`, upstream.status);
  }

  let totalUsage: AnthropicUsageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  let latestAnthropicStopMetadata: AnthropicStopMetadata | null = null;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const enqueue = (data: string) => {
        controller.enqueue(encoder.encode(`data: ${data}\n\n`));
      };

      async function processStream(response: globalThis.Response): Promise<{
        toolCalls: Array<{ name: string; id: string; args: Record<string, unknown> }>;
        usage: AnthropicUsageTotals;
        stopMetadata: AnthropicStopMetadata | null;
      }> {
        const reader = response.body?.getReader();
        if (!reader) {
          return {
            toolCalls: [],
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
            stopMetadata: null,
          };
        }

        const decoder = new TextDecoder();
        let buffer = '';
        const toolCalls: Array<{ name: string; id: string; args: Record<string, unknown> }> = [];
        let currentToolName = '';
        let currentToolId = '';
        let currentToolArgs = '';
        const usage: AnthropicUsageTotals = {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        };
        let stopMetadata: AnthropicStopMetadata | null = null;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (provider === 'anthropic') {
              const anthropicUsage = parseAnthropicStreamUsage(line);
              if (anthropicUsage) {
                usage.cacheReadTokens = Math.max(usage.cacheReadTokens, anthropicUsage.cacheReadTokens);
                usage.cacheWriteTokens = Math.max(usage.cacheWriteTokens, anthropicUsage.cacheWriteTokens);
              }
              stopMetadata = mergeAnthropicStopState(stopMetadata, parseAnthropicStopMetadata(line));
            }
            const parsed = config.parseStream(line);
            if (!parsed) continue;

            if (parsed.type === 'thinking') {
              enqueue(JSON.stringify({ type: 'thinking', text: parsed.text }));
              continue;
            }
            if (parsed.type === 'content') {
              enqueue(JSON.stringify({ type: 'content', text: parsed.text }));
              continue;
            }
            if (parsed.type === 'usage') {
              usage.inputTokens += parsed.inputTokens;
              usage.outputTokens += parsed.outputTokens;
              continue;
            }
            if (parsed.type === 'tool_call_start') {
              currentToolName = parsed.toolName;
              currentToolId = parsed.toolId;
              currentToolArgs = '';
              enqueue(JSON.stringify({ type: 'tool_call', name: parsed.toolName, status: 'calling' }));
              continue;
            }
            if (parsed.type === 'tool_call_delta') {
              currentToolArgs += parsed.json;
              continue;
            }
            if (parsed.type === 'tool_call_end') {
              try {
                const args = currentToolArgs ? JSON.parse(currentToolArgs) as Record<string, unknown> : {};
                toolCalls.push({ name: currentToolName, id: currentToolId, args });
              } catch {
                toolCalls.push({ name: currentToolName, id: currentToolId, args: {} });
              }
              continue;
            }
            if (parsed.type === 'tool_call') {
              toolCalls.push({ name: parsed.toolName, id: parsed.toolId, args: parsed.args });
              enqueue(JSON.stringify({ type: 'tool_call', name: parsed.toolName, status: 'calling' }));
            }
          }
        }

        return { toolCalls, usage, stopMetadata };
      }

      try {
        const initialResult = await processStream(upstream);
        let toolCalls = initialResult.toolCalls;
        const { usage, stopMetadata } = initialResult;
        totalUsage = {
          inputTokens: totalUsage.inputTokens + usage.inputTokens,
          outputTokens: totalUsage.outputTokens + usage.outputTokens,
          cacheReadTokens: totalUsage.cacheReadTokens + usage.cacheReadTokens,
          cacheWriteTokens: totalUsage.cacheWriteTokens + usage.cacheWriteTokens,
        };
        latestAnthropicStopMetadata = mergeAnthropicStopState(latestAnthropicStopMetadata, stopMetadata);
        if (stopMetadata?.stopReason === 'budget_exhausted') {
          console.info(`[llm-proxy] Anthropic stop_reason=budget_exhausted model=${model}`);
        }
        let loopCount = 0;
        const allSources: Array<{ title: string; url?: string; path?: string }> = [];

        while (toolCalls.length > 0 && loopCount < 8) {
          loopCount += 1;
          const toolResultParts: string[] = [];

          for (const toolCall of toolCalls) {
            const toolOverride = toolOverrides[toolCall.name];
            if (toolOverride && typeof toolOverride === 'object') {
              toolCall.args = { ...toolCall.args, ...toolOverride };
            }

            const policyContext = buildPolicyContext(toolCall.name, toolCall.args, {
              runtime: 'chat',
              workspacePath: effectiveRepoRoot,
              sessionKey: tabId ? `llm-chat:${tabId}` : undefined,
            });
            const policyResult = approvedTools.has(toolCall.name)
              ? { requiresApproval: false, risk: 'low' as const, reason: 'Pre-approved', ruleId: 'pre-approved', blocked: false }
              : evaluatePolicy(policyContext);

            if (policyResult.blocked) {
              const command = (toolCall.args.command as string) || toolCall.name;
              enqueue(JSON.stringify({
                type: 'tool_result',
                name: toolCall.name,
                status: 'blocked',
                preview: `Blocked: ${policyResult.reason}`,
              }));
              messages.push(
                { role: 'assistant', content: `I'll run: ${command}` },
                { role: 'user', content: `Tool "${toolCall.name}" was blocked by policy "${policyResult.ruleId}": ${policyResult.reason}. Suggest a safe alternative.` },
              );
              continue;
            }

            if (policyResult.requiresApproval) {
              const command = toolCall.name === 'run_terminal_command' ? (toolCall.args.command as string) : '';
              let summary = `Execute ${toolCall.name}`;
              let diff: { before?: string; after?: string; path?: string } | undefined;

              if (toolCall.name === 'create_github_issue') {
                summary = `Create issue: "${toolCall.args.title}" in ${toolCall.args.repo}`;
              } else if (toolCall.name === 'create_pull_request') {
                summary = `Create PR: "${toolCall.args.title}" on branch ${toolCall.args.branch}`;
              } else if (toolCall.name === 'run_terminal_command') {
                summary = `Run command: ${command}`;
              } else if (toolCall.name === 'write_file') {
                const filePath = String(toolCall.args.path || '');
                const content = String(toolCall.args.content || '');
                summary = `Write to ${filePath} (${content.split('\n').length} lines)`;
                diff = { before: '', after: content, path: filePath };
              } else if (toolCall.name === 'edit_file') {
                const filePath = String(toolCall.args.path || '');
                summary = `Edit ${filePath}`;
                diff = {
                  before: String(toolCall.args.oldText || ''),
                  after: String(toolCall.args.newText || ''),
                  path: filePath,
                };
              } else if (toolCall.name === 'delete_file') {
                summary = `Delete file: ${toolCall.args.path}`;
              }

              const approval = tabId
                ? createApproval({
                    source: 'llm-chat',
                    runtime: 'chat',
                    agent: 'Chat',
                    sessionKey: `llm-chat:${tabId}`,
                    title: approvalTitleForTool(toolCall.name),
                    description: summary,
                    summary,
                    toolName: toolCall.name,
                    args: toolCall.args,
                    command: command || undefined,
                    editable: toolCall.name === 'run_terminal_command',
                    diff,
                    risk: policyResult.risk,
                    policyRuleId: policyResult.ruleId,
                    metadata: {
                      Model: model,
                      Tool: toolCall.name,
                      ...(command ? { Command: command } : {}),
                      ...(!command && toolCall.args.path ? { Path: String(toolCall.args.path) } : {}),
                    },
                    continuation: {
                      kind: 'llm-chat',
                      tabId,
                      model,
                      provider,
                      messages: rawMessages,
                      approvedTools: [...approvedTools],
                      repoPath: effectiveRepoRoot,
                    },
                  })
                : null;

              enqueue(JSON.stringify({
                type: 'approval_required',
                id: approval?.id,
                name: toolCall.name,
                args: toolCall.args,
                editable: toolCall.name === 'run_terminal_command',
                summary,
                diff,
              }));
              enqueue(JSON.stringify({ type: 'content', text: '' }));
              enqueue(JSON.stringify(buildUsageEvent(provider, model, totalUsage, {
                stopMetadata: latestAnthropicStopMetadata,
                taskBudget: anthropicTaskBudget,
              })));
              enqueue('[DONE]');
              controller.close();
              return;
            }

            enqueue(JSON.stringify({
              type: 'tool_call',
              name: toolCall.name,
              status: 'running',
              args: toolCall.args,
            }));

            const result: ToolResult = await executeTool(toolCall.name, toolCall.args, effectiveRepoRoot);
            if (result.sources) {
              allSources.push(...result.sources);
            }

            enqueue(JSON.stringify({
              type: 'tool_result',
              name: toolCall.name,
              status: 'done',
              preview: result.content.slice(0, 200),
            }));
            toolResultParts.push(`[${toolCall.name}] ${result.content}`);
          }

          const toolNames = toolCalls.map((toolCall) => toolCall.name).join(', ');
          messages.push(
            { role: 'assistant', content: `I used the following tools: ${toolNames}` },
            {
              role: 'user',
              content: `Tool results:\n\n${toolResultParts.join('\n\n---\n\n')}\n\nBased on these results, provide your complete response to the user. Do not call more tools unless absolutely necessary.`,
            },
          );

          let followResponse: globalThis.Response;
          try {
            followResponse = await fetchWithTimeout(
              config.url,
              headers,
              JSON.stringify(buildUpstreamBody(messages)),
            );
          } catch {
            break;
          }
          if (!followResponse.ok) {
            break;
          }
          const followResult = await processStream(followResponse);
          toolCalls = followResult.toolCalls;
          totalUsage = {
            inputTokens: totalUsage.inputTokens + followResult.usage.inputTokens,
            outputTokens: totalUsage.outputTokens + followResult.usage.outputTokens,
            cacheReadTokens: totalUsage.cacheReadTokens + followResult.usage.cacheReadTokens,
            cacheWriteTokens: totalUsage.cacheWriteTokens + followResult.usage.cacheWriteTokens,
          };
          latestAnthropicStopMetadata = mergeAnthropicStopState(
            latestAnthropicStopMetadata,
            followResult.stopMetadata,
          );
          if (followResult.stopMetadata?.stopReason === 'budget_exhausted') {
            console.info(`[llm-proxy] Anthropic stop_reason=budget_exhausted model=${model}`);
          }
        }

        const seen = new Set<string>();
        const sources = allSources.filter((source) => {
          const key = `${source.title}|${source.url ?? ''}|${source.path ?? ''}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        if (sources.length > 0) {
          enqueue(JSON.stringify({
            type: 'sources',
            sources: sources.map((source, index) => ({ ...source, index: index + 1 })),
          }));
        }

        const usageEvent = buildUsageEvent(provider, model, totalUsage, {
          stopMetadata: latestAnthropicStopMetadata,
          taskBudget: anthropicTaskBudget,
        });
        enqueue(JSON.stringify(usageEvent));
        enqueue('[DONE]');

        if (auth?.user && totalUsage.outputTokens > 0) {
          try {
            const costUsd = typeof usageEvent.costUsd === 'number' ? usageEvent.costUsd : 0;
            logUsage({
              userId: auth.user.id,
              model,
              provider,
              inputTokens: totalUsage.inputTokens,
              outputTokens: totalUsage.outputTokens,
              cacheReadTokens: totalUsage.cacheReadTokens,
              cacheWriteTokens: totalUsage.cacheWriteTokens,
              costUsd,
              agentName: 'llm-chat',
              requestType: 'chat',
            });
          } catch (error) {
            console.error('[proxy/llm] Failed to log usage:', error);
          }
        }
      } catch (error) {
        enqueue(JSON.stringify({
          type: 'error',
          message: error instanceof Error ? error.message : 'Stream error',
        }));
      } finally {
        try {
          controller.close();
        } catch {
          return;
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
});
