export const dynamic = 'force-dynamic';

import { NextRequest } from 'next/server';
import { createApproval } from '@/lib/approvals/store';
import { evaluatePolicy, buildPolicyContext } from '@/lib/approvals/policies';
import { withOptionalAuth, type AuthContext } from '@/lib/auth/middleware';
import { logUsage, getCurrentPeriodCost } from '@/lib/db/usage';
import {
  parseAnthropicStopMetadata,
  resolveAnthropicTaskBudget,
  type AnthropicStopMetadata,
  type ResolvedAnthropicTaskBudget,
} from '@/lib/llm/anthropic-task-budget';
import { getWorkspaceContext, buildSystemPrompt } from '@/lib/llm/context';
import { getPersonalizedChatFtuxPayload } from '@/lib/llm/personalized-chat-ftux';
import { LLM_REPO_PATH_HEADER } from '@/lib/llm/repo-scope';
import { executeTool, type ToolResult } from '@/lib/llm/tools';
import { resolveRepoPathFromRegistry } from '@/lib/repos/repo-path-registry';
import {
  computeCost,
  isSupportedProvider,
  OPERATOR_GEMINI_MODEL,
  OPERATOR_OPENROUTER_MODEL,
  PROVIDERS,
  resolveApiKey,
  type Message,
} from './provider-config';
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

function anthropicPricingForModel(model: string) {
  const normalizedModel = model.trim().toLowerCase();
  if (!normalizedModel) return null;
  if (normalizedModel.includes('claude-opus-4-7')) return { input: 5, output: 25 };
  if (normalizedModel.includes('claude-opus-4-6')) return { input: 15, output: 75 };
  if (normalizedModel.includes('claude-sonnet-4-6')) return { input: 3, output: 15 };
  if (normalizedModel.includes('claude-sonnet-4-5') || normalizedModel.includes('claude-sonnet-4')) return { input: 3, output: 15 };
  if (normalizedModel.includes('claude-haiku-4-5') || normalizedModel.includes('claude-haiku')) return { input: 0.8, output: 4 };
  return null;
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
  } = body as {
    model: string;
    provider: string;
    messages: Message[];
    approvedTools?: string[];
    disableTools?: boolean;
    repoPath?: string;
    toolOverrides?: Record<string, Record<string, unknown>>;
  };

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
  if (requestedRepoPath) {
    const resolvedRepo = await resolveRepoPathFromRegistry(requestedRepoPath);
    if (!resolvedRepo.ok) {
      return jsonError(resolvedRepo.message, resolvedRepo.status);
    }
    effectiveRepoRoot = resolvedRepo.repoRoot;
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

  if (auth?.user && auth.user.plan !== 'free') {
    const spent = getCurrentPeriodCost(auth.user.id);
    const budget = auth.user.tokenBudgetUsd;
    if (budget != null && spent >= budget) {
      return jsonError('Monthly token budget exceeded. Upgrade your plan or add a BYOK key.', 402);
    }
  }

  // o8 Operator — try Gemini Flash with the user's Google key; if quota is exhausted,
  // fall back to a free OpenRouter model. Uses the same plumbing as a regular google call.
  if (provider === 'operator') {
    const geminiKey = process.env.GOOGLE_AI_API_KEY ?? null;
    if (geminiKey) {
      const geminiResponse = await createGoogleToolResponseStream({
        apiKey: geminiKey,
        auth,
        disableTools,
        lastUserContent: lastUserMsg?.content,
        messages,
        model: OPERATOR_GEMINI_MODEL,
        scopedRepoRoot: effectiveRepoRoot,
        tabId,
      });
      const status = geminiResponse.status;
      if (geminiResponse.ok || (status !== 429 && status !== 503 && status !== 402)) {
        return geminiResponse;
      }
      // Drop the failed Gemini response; fall through to OpenRouter.
    }
    const openRouterKey = process.env.OPENROUTER_API_KEY ?? null;
    if (!openRouterKey) {
      return jsonError(
        'o8 Operator unavailable: Gemini quota exhausted and no OPENROUTER_API_KEY configured for fallback.',
        503,
      );
    }
    return streamOpenRouterFallback({
      apiKey: openRouterKey,
      messages,
      model: OPERATOR_OPENROUTER_MODEL,
      auth,
    });
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
  const buildUpstreamBody = (requestMessages: Message[]) => {
    const upstreamBody = withAnthropicPromptCaching(
      config.buildBody(model, requestMessages) as Record<string, unknown>,
      provider,
    );
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
  let fullResponseText = '';

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
              fullResponseText += parsed.text;
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
        let { toolCalls, usage, stopMetadata } = await processStream(upstream);
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
