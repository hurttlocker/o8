export const dynamic = 'force-dynamic';

/**
 * POST /api/v2/proxy/llm
 *
 * Token relay — proxies LLM API calls, meters tokens, enforces budgets.
 * This is the revenue surface for Cortex IDE.
 *
 * Streaming response via SSE (Server-Sent Events):
 *   data: {"type":"content","text":"Hello"}
 *   data: {"type":"usage","inputTokens":12,"outputTokens":45,"costUsd":0.0023}
 *   data: [DONE]
 *
 * Issue: https://github.com/hurttlocker/cortex-ide/issues/232
 */

import { NextRequest } from 'next/server';
import { withOptionalAuth, type AuthContext } from '@/lib/auth/middleware';
import { logUsage, getCurrentPeriodCost } from '@/lib/db/usage';
import { getWorkspaceContext, buildSystemPrompt } from '@/lib/llm/context';
import { recallMemories, extractAndStoreFacts } from '@/lib/llm/memory';
import { toolsForAnthropic, toolsForOpenAI, toolsForGoogle, executeTool, APPROVAL_REQUIRED_TOOLS, classifyCommand, type ToolResult } from '@/lib/llm/tools';

// ── Pricing (per 1M tokens) ──

const PRICING: Record<string, { input: number; output: number }> = {
  // Google
  'gemini-3.1-pro-preview': { input: 1.25, output: 10 },
  'gemini-3-pro-preview':   { input: 1.25, output: 10 },
  'gemini-3-flash-preview': { input: 0.15, output: 0.60 },
  'gemini-2.5-pro':         { input: 1.25, output: 10 },
  'gemini-2.5-flash':       { input: 0.15, output: 0.60 },
  'gemini-2.5-flash-lite':  { input: 0.04, output: 0.15 },
  // Anthropic
  'claude-opus-4-6':   { input: 15,   output: 75 },
  'claude-sonnet-4-5': { input: 3,    output: 15 },
  'claude-haiku-4-5':  { input: 0.80, output: 4 },
  // OpenAI
  'gpt-5.4':           { input: 2.50, output: 10 },
  'gpt-4o':            { input: 2.50, output: 10 },
  'o3':                { input: 10,   output: 40 },
};

function computeCost(model: string, inputTokens: number, outputTokens: number): number {
  const price = PRICING[model];
  if (!price) return 0;
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

// ── Provider configs ──

type Provider = 'anthropic' | 'openai' | 'google';

interface ProviderConfig {
  url: string;
  envKey: string;
  buildHeaders: (apiKey: string) => Record<string, string>;
  buildBody: (model: string, messages: Message[]) => Record<string, unknown>;
  parseStream: (line: string) => StreamEvent | null;
}

type StreamEvent =
  | { type: 'content'; text: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'done' }
  | { type: 'tool_call_start'; toolName: string; toolId: string }
  | { type: 'tool_call_delta'; json: string }
  | { type: 'tool_call_end' }
  | { type: 'tool_call'; toolName: string; toolId: string; args: Record<string, unknown> }
  | { type: 'thinking'; text: string }
  | { type: 'thinking_done' };

interface Message {
  role: string;
  content: string;
}

const PROVIDERS: Record<Provider, ProviderConfig> = {
  anthropic: {
    url: 'https://api.anthropic.com/v1/messages',
    envKey: 'ANTHROPIC_API_KEY',
    buildHeaders: (apiKey) => ({
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    }),
    buildBody: (model, messages) => ({
      model,
      max_tokens: 4096,
      stream: true,
      messages: messages
        .filter(m => m.role !== 'system')
        .map(m => {
          // Check for inline images (data URIs in markdown syntax)
          const imgRegex = /!\[([^\]]*)\]\((data:([^;]+);base64,([^)]+))\)/g;
          const contentParts: Record<string, unknown>[] = [];
          let lastIdx = 0;
          let match: RegExpExecArray | null;
          while ((match = imgRegex.exec(m.content))) {
            const textBefore = m.content.slice(lastIdx, match.index).trim();
            if (textBefore) contentParts.push({ type: 'text', text: textBefore });
            contentParts.push({
              type: 'image',
              source: { type: 'base64', media_type: match[3], data: match[4] },
            });
            lastIdx = match.index + match[0].length;
          }
          const remaining = m.content.slice(lastIdx).trim();
          if (remaining) contentParts.push({ type: 'text', text: remaining });
          // Only use multipart if images found
          if (contentParts.length > 1 || contentParts.some(p => p.type === 'image')) {
            return { role: m.role, content: contentParts };
          }
          return { role: m.role, content: m.content };
        }),
      ...(messages.find(m => m.role === 'system')
        ? { system: messages.find(m => m.role === 'system')!.content }
        : {}),
      tools: toolsForAnthropic(),
    }),
    parseStream: (line) => {
      if (!line.startsWith('data: ')) return null;
      const data = line.slice(6).trim();
      if (data === '[DONE]') return { type: 'done' };
      try {
        const parsed = JSON.parse(data);
        if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
          return { type: 'content', text: parsed.delta.text };
        }
        // Extended thinking detection
        if (parsed.type === 'content_block_start' && parsed.content_block?.type === 'thinking') {
          return { type: 'thinking', text: '' };
        }
        if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'thinking_delta') {
          return { type: 'thinking', text: parsed.delta.thinking ?? '' };
        }
        // Tool use detection
        if (parsed.type === 'content_block_start' && parsed.content_block?.type === 'tool_use') {
          return { type: 'tool_call_start', toolName: parsed.content_block.name, toolId: parsed.content_block.id };
        }
        if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'input_json_delta') {
          return { type: 'tool_call_delta', json: parsed.delta.partial_json };
        }
        if (parsed.type === 'content_block_stop') {
          return { type: 'tool_call_end' };
        }
        if (parsed.type === 'message_delta' && parsed.usage) {
          return { type: 'usage', inputTokens: parsed.usage.input_tokens ?? 0, outputTokens: parsed.usage.output_tokens ?? 0 };
        }
        if (parsed.type === 'message_start' && parsed.message?.usage) {
          return { type: 'usage', inputTokens: parsed.message.usage.input_tokens ?? 0, outputTokens: 0 };
        }
      } catch { /* ignore */ }
      return null;
    },
  },

  openai: {
    url: 'https://api.openai.com/v1/chat/completions',
    envKey: 'OPENAI_API_KEY',
    buildHeaders: (apiKey) => ({
      'Authorization': `Bearer ${apiKey}`,
      'content-type': 'application/json',
    }),
    buildBody: (model, messages) => ({
      model,
      stream: true,
      stream_options: { include_usage: true },
      messages: messages.map(m => {
        // Check for inline images (data URIs in markdown syntax)
        const imgRegex = /!\[([^\]]*)\]\((data:([^;]+);base64,[^)]+)\)/g;
        if (imgRegex.test(m.content)) {
          imgRegex.lastIndex = 0;
          const contentParts: Record<string, unknown>[] = [];
          let lastIdx = 0;
          let match: RegExpExecArray | null;
          while ((match = imgRegex.exec(m.content))) {
            const textBefore = m.content.slice(lastIdx, match.index).trim();
            if (textBefore) contentParts.push({ type: 'text', text: textBefore });
            contentParts.push({ type: 'image_url', image_url: { url: match[2] } });
            lastIdx = match.index + match[0].length;
          }
          const remaining = m.content.slice(lastIdx).trim();
          if (remaining) contentParts.push({ type: 'text', text: remaining });
          return { role: m.role, content: contentParts };
        }
        return m;
      }),
      tools: toolsForOpenAI(),
    }),
    parseStream: (line) => {
      if (!line.startsWith('data: ')) return null;
      const data = line.slice(6).trim();
      if (data === '[DONE]') return { type: 'done' };
      try {
        const parsed = JSON.parse(data);
        if (parsed.choices?.[0]?.delta?.content) {
          return { type: 'content', text: parsed.choices[0].delta.content };
        }
        // OpenAI tool calls
        const tc = parsed.choices?.[0]?.delta?.tool_calls?.[0];
        if (tc?.function?.name) {
          return { type: 'tool_call_start', toolName: tc.function.name, toolId: tc.id || '' };
        }
        if (tc?.function?.arguments) {
          return { type: 'tool_call_delta', json: tc.function.arguments };
        }
        if (parsed.choices?.[0]?.finish_reason === 'tool_calls') {
          return { type: 'tool_call_end' };
        }
        if (parsed.usage) {
          return { type: 'usage', inputTokens: parsed.usage.prompt_tokens ?? 0, outputTokens: parsed.usage.completion_tokens ?? 0 };
        }
      } catch { /* ignore */ }
      return null;
    },
  },

  google: {
    url: 'https://generativelanguage.googleapis.com/v1beta/models',
    envKey: 'GOOGLE_AI_API_KEY',
    buildHeaders: () => ({
      'content-type': 'application/json',
    }),
    buildBody: (model, messages) => ({
      contents: messages
        .filter(m => m.role !== 'system')
        .map(m => {
          const parts: Record<string, unknown>[] = [];
          // Parse content for inline images (data URIs)
          const imgRegex = /!\[([^\]]*)\]\((data:[^)]+)\)/g;
          let lastIdx = 0;
          let match: RegExpExecArray | null;
          const content = m.content;
          while ((match = imgRegex.exec(content))) {
            const textBefore = content.slice(lastIdx, match.index).trim();
            if (textBefore) parts.push({ text: textBefore });
            // Parse data URI: data:mime;base64,DATA
            const dataUri = match[2];
            const commaIdx = dataUri.indexOf(',');
            if (commaIdx > 0) {
              const mimeMatch = dataUri.match(/^data:([^;]+);base64/);
              const mime = mimeMatch?.[1] || 'image/png';
              const data = dataUri.slice(commaIdx + 1);
              parts.push({ inlineData: { mimeType: mime, data } });
            }
            lastIdx = match.index + match[0].length;
          }
          const remaining = content.slice(lastIdx).trim();
          if (remaining) parts.push({ text: remaining });
          if (parts.length === 0) parts.push({ text: content });
          return { role: m.role === 'assistant' ? 'model' : 'user', parts };
        }),
      ...(messages.find(m => m.role === 'system')
        ? { systemInstruction: { parts: [{ text: messages.find(m => m.role === 'system')!.content }] } }
        : {}),
      tools: toolsForGoogle(),
    }),
    parseStream: (line) => {
      // Google SSE: "data: {...}" lines
      let raw = line.trim();
      if (!raw) return null;
      if (raw.startsWith('data: ')) raw = raw.slice(6).trim();
      if (!raw || raw === '[' || raw === ']' || raw === ',') return null;
      try {
        const parsed = JSON.parse(raw.replace(/^,/, ''));
        const parts = parsed.candidates?.[0]?.content?.parts;
        if (parts) {
          for (const part of parts) {
            // Google thinking/thought parts
            if (part.thought === true && part.text) {
              return { type: 'thinking', text: part.text };
            }
            if (part.functionCall) {
              return {
                type: 'tool_call',
                toolName: part.functionCall.name,
                toolId: part.functionCall.name + '-' + Date.now(),
                args: part.functionCall.args ?? {},
              };
            }
            if (part.text) {
              return { type: 'content', text: part.text };
            }
            if (part.inlineData) {
              // Gemini returns images as base64 inlineData
              const mime = part.inlineData.mimeType || 'image/png';
              const b64 = part.inlineData.data;
              return { type: 'content', text: `\n![Generated Image](data:${mime};base64,${b64})\n` };
            }
          }
        }
        if (parsed.usageMetadata) {
          return {
            type: 'usage',
            inputTokens: parsed.usageMetadata.promptTokenCount ?? 0,
            outputTokens: parsed.usageMetadata.candidatesTokenCount ?? 0,
          };
        }
      } catch { /* ignore */ }
      return null;
    },
  },
};

// ── Resolve API key ──

function resolveApiKey(provider: Provider): string | null {
  // For v1: use server-side env vars (BYOK later via api_keys table)
  const config = PROVIDERS[provider];
  return process.env[config.envKey] ?? null;
}

// ── Handler ──

export const POST = withOptionalAuth(async (request: NextRequest, auth: AuthContext | null) => {
  const body = await request.json().catch(() => null);
  if (!body?.model || !body?.provider || !Array.isArray(body?.messages)) {
    return new Response(
      JSON.stringify({ error: 'model, provider, and messages are required' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const { model, provider, messages: rawMessages, approvedTools: approvedToolsList } = body as {
    model: string;
    provider: Provider;
    messages: Message[];
    approvedTools?: string[];
  };
  const approvedTools = new Set(approvedToolsList ?? []);

  // Inject workspace context as system prompt (Phase 1)
  const wsContext = getWorkspaceContext();
  let systemPrompt = buildSystemPrompt(wsContext);

  // Phase A: Cortex memory recall — search for relevant facts based on user's message
  let recallInfo: { factCount: number; queryMs: number } | null = null;
  const lastUserMsg = [...rawMessages].reverse().find(m => m.role === 'user');
  if (lastUserMsg?.content) {
    try {
      const recall = await recallMemories(lastUserMsg.content);
      if (recall && recall.factCount > 0) {
        systemPrompt += `\n\n${recall.text}`;
        recallInfo = { factCount: recall.factCount, queryMs: recall.queryMs };
        console.log(`[memory-recall] ${recall.factCount} facts recalled in ${recall.queryMs}ms`);
      }
    } catch (err) {
      console.error('[memory-recall] Failed:', err);
    }
  }

  const hasSystem = rawMessages.some(m => m.role === 'system');
  const messages: Message[] = hasSystem
    ? rawMessages
    : [{ role: 'system', content: systemPrompt }, ...rawMessages];

  if (!PROVIDERS[provider]) {
    return new Response(
      JSON.stringify({ error: `Unsupported provider: ${provider}` }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // Check budget for authenticated users on managed keys
  if (auth?.user && auth.user.plan !== 'free') {
    const spent = getCurrentPeriodCost(auth.user.id);
    const budget = auth.user.tokenBudgetUsd;
    if (budget != null && spent >= budget) {
      return new Response(
        JSON.stringify({ error: 'Monthly token budget exceeded. Upgrade your plan or add a BYOK key.' }),
        { status: 402, headers: { 'Content-Type': 'application/json' } },
      );
    }
  }

  const apiKey = resolveApiKey(provider);
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: `No API key configured for ${provider}. Set ${PROVIDERS[provider].envKey} in your environment.` }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const config = PROVIDERS[provider];
  console.log(`[llm-proxy] ${provider}/${model} — ${messages.length} messages`);

  // Build the upstream request
  let url = config.url;
  if (provider === 'google') {
    url = `${config.url}/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;
  }

  const headers = config.buildHeaders(apiKey);
  const upstreamBody = config.buildBody(model, messages);

  try {
    const upstream = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(upstreamBody),
    });

    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => 'Unknown error');
      return new Response(
        JSON.stringify({ error: `${provider} API error (${upstream.status}): ${errText.slice(0, 500)}` }),
        { status: upstream.status, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // Stream the response with tool call support
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let fullResponseText = '';

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const enqueue = (data: string) => controller.enqueue(encoder.encode(`data: ${data}\n\n`));

        // Send memory recall indicator if facts were found
        if (recallInfo) {
          enqueue(JSON.stringify({ type: 'memory_recall', factCount: recallInfo.factCount, queryMs: recallInfo.queryMs }));
        }

        // Helper: read a stream and process events
        async function processStream(response: globalThis.Response): Promise<{
          toolCalls: { name: string; id: string; args: Record<string, unknown> }[];
        }> {
          const reader = response.body?.getReader();
          if (!reader) return { toolCalls: [] };

          const decoder = new TextDecoder();
          let buffer = '';
          const toolCalls: { name: string; id: string; args: Record<string, unknown> }[] = [];
          let currentToolName = '';
          let currentToolId = '';
          let currentToolArgs = '';

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const line of lines) {
              const parsed = config.parseStream(line);
              if (!parsed) continue;

              if (parsed.type === 'thinking') {
                enqueue(JSON.stringify({ type: 'thinking', text: parsed.text }));
              } else if (parsed.type === 'content') {
                fullResponseText += parsed.text;
                enqueue(JSON.stringify({ type: 'content', text: parsed.text }));
              } else if (parsed.type === 'usage') {
                totalInputTokens += parsed.inputTokens;
                totalOutputTokens += parsed.outputTokens;
              } else if (parsed.type === 'tool_call_start') {
                currentToolName = parsed.toolName;
                currentToolId = parsed.toolId;
                currentToolArgs = '';
                // Notify frontend
                enqueue(JSON.stringify({ type: 'tool_call', name: parsed.toolName, status: 'calling' }));
              } else if (parsed.type === 'tool_call_delta') {
                currentToolArgs += parsed.json;
              } else if (parsed.type === 'tool_call_end') {
                try {
                  const args = currentToolArgs ? JSON.parse(currentToolArgs) : {};
                  toolCalls.push({ name: currentToolName, id: currentToolId, args });
                } catch {
                  toolCalls.push({ name: currentToolName, id: currentToolId, args: {} });
                }
              } else if (parsed.type === 'tool_call') {
                // Google returns complete tool calls
                toolCalls.push({ name: parsed.toolName, id: parsed.toolId, args: parsed.args });
                enqueue(JSON.stringify({ type: 'tool_call', name: parsed.toolName, status: 'calling' }));
              } else if (parsed.type === 'done') {
                break;
              }
            }
          }

          return { toolCalls };
        }

        try {
          // Process initial stream
          let { toolCalls } = await processStream(upstream);
          let loopCount = 0;
          const maxLoops = 5; // Safety limit
          const allSources: { title: string; url?: string; path?: string }[] = [];

          // Tool call loop — execute tools and send results back to model
          while (toolCalls.length > 0 && loopCount < maxLoops) {
            loopCount++;

            for (const tc of toolCalls) {
              // Check if this tool requires user approval (skip if pre-approved)
              let needsApproval = APPROVAL_REQUIRED_TOOLS.has(tc.name) && !approvedTools.has(tc.name);

              // Dynamic approval for terminal commands based on safety classification
              if (tc.name === 'run_terminal_command' && !approvedTools.has('run_terminal_command')) {
                const cmd = (tc.args.command as string) || '';
                const classification = classifyCommand(cmd);
                if (classification.safety === 'blocked') {
                  // Blocked: send result directly back to model as a refusal
                  enqueue(JSON.stringify({ type: 'tool_result', name: tc.name, status: 'blocked', preview: `Blocked: ${classification.reason}` }));
                  messages.push(
                    { role: 'assistant', content: `I'll run the command: ${cmd}` },
                    { role: 'user', content: `Tool "run_terminal_command" was BLOCKED for safety: ${classification.reason}. Do not attempt this command again. Suggest a safe alternative.` }
                  );
                  continue;
                }
                needsApproval = classification.safety === 'needs_approval';
              }

              if (needsApproval) {
                const cmd = tc.name === 'run_terminal_command' ? (tc.args.command as string) : '';
                enqueue(JSON.stringify({
                  type: 'approval_required',
                  name: tc.name,
                  args: tc.args,
                  editable: tc.name === 'run_terminal_command', // terminal commands can be edited
                  summary: tc.name === 'create_github_issue'
                    ? `Create issue: "${tc.args.title}" in ${tc.args.repo}`
                    : tc.name === 'create_pull_request'
                    ? `Create PR: "${tc.args.title}" on branch ${tc.args.branch}`
                    : tc.name === 'run_terminal_command'
                    ? `Run command: ${cmd}`
                    : `Execute ${tc.name}`,
                }));
                // Stop the loop — frontend will re-submit with approval
                enqueue(JSON.stringify({ type: 'content', text: '' }));
                enqueue(JSON.stringify({ type: 'usage', inputTokens: totalInputTokens, outputTokens: totalOutputTokens, costUsd: 0 }));
                enqueue('[DONE]');
                controller.close();
                return;
              }

              enqueue(JSON.stringify({ type: 'tool_call', name: tc.name, status: 'running', args: tc.args }));

              // Execute the tool
              const result: ToolResult = await executeTool(tc.name, tc.args);

              if (result.sources) {
                allSources.push(...result.sources);
              }

              enqueue(JSON.stringify({ type: 'tool_result', name: tc.name, status: 'done', preview: result.content.slice(0, 200) }));

              // Build follow-up request with tool results
              // For now, make a new request with the tool result as context
              const toolResultMsg = `Tool "${tc.name}" returned:\n${result.content}`;
              messages.push(
                { role: 'assistant', content: `I'll use the ${tc.name} tool to help answer this.` },
                { role: 'user', content: toolResultMsg }
              );
            }

            // Make follow-up request to model with tool results
            const followUrl = provider === 'google'
              ? `${config.url}/${model}:streamGenerateContent?alt=sse&key=${apiKey}`
              : config.url;
            const followBody = config.buildBody(model, messages);
            const followRes = await fetch(followUrl, {
              method: 'POST',
              headers,
              body: JSON.stringify(followBody),
            });

            if (!followRes.ok) break;

            const result = await processStream(followRes);
            toolCalls = result.toolCalls;
          }

          // Send numbered sources (deduplicated)
          if (allSources.length > 0) {
            const seen = new Set<string>();
            const unique = allSources.filter(s => {
              const key = `${s.title}|${s.url ?? ''}|${s.path ?? ''}`;
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            });
            const numbered = unique.map((s, i) => ({ ...s, index: i + 1 }));
            enqueue(JSON.stringify({ type: 'sources', sources: numbered }));
          }

          // Send final usage event
          const costUsd = computeCost(model, totalInputTokens, totalOutputTokens);
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({
            type: 'usage',
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            costUsd,
          })}\n\n`));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          console.log(`[llm-proxy] ${provider}/${model} — ${totalInputTokens} in / ${totalOutputTokens} out — $${costUsd.toFixed(4)}`);

          // Log usage for authenticated users
          if (auth?.user && totalOutputTokens > 0) {
            try {
              logUsage({
                userId: auth.user.id,
                model,
                provider,
                inputTokens: totalInputTokens,
                outputTokens: totalOutputTokens,
                costUsd,
                agentName: 'llm-chat',
                requestType: 'chat',
              });
            } catch (e) {
              console.error('[proxy/llm] Failed to log usage:', e);
            }
          }
          // Phase B: Background fact extraction (fire-and-forget)
          if (lastUserMsg?.content && fullResponseText.length > 50) {
            const tabIdHeader = request.headers.get('x-tab-id') || undefined;
            extractAndStoreFacts(lastUserMsg.content, fullResponseText, tabIdHeader)
              .then(result => {
                if (result && result.factsStored > 0) {
                  console.log(`[memory-extract] Phase B: ${result.factsStored} new facts stored in ${result.durationMs}ms`);
                }
              })
              .catch(err => {
                console.error('[memory-extract] Phase B failed:', err);
              });
          }
        } catch (err) {
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({
              type: 'error',
              message: err instanceof Error ? err.message : 'Stream error',
            })}\n\n`));
          } catch { /* controller may already be closed */ }
        } finally {
          try {
            controller.close();
          } catch { /* already closed (e.g. approval early-exit) */ }
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : 'Proxy request failed' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
});
