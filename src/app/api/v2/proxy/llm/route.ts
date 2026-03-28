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
import { createApproval } from '@/lib/approvals/store';
import type { ApprovalRisk } from '@/lib/approvals/types';
import { withOptionalAuth, type AuthContext } from '@/lib/auth/middleware';
import { logUsage, getCurrentPeriodCost } from '@/lib/db/usage';
import { getWorkspaceContext, buildSystemPrompt, buildUnscopedSystemPrompt } from '@/lib/llm/context';
import { resolveRepoScopeFromHeaders } from '@/lib/llm/repo-scope';
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
    buildBody: (model, messages) => {
      // Detect if model supports extended thinking
      const isThinkingModel = /opus|sonnet-4/.test(model);
      const maxTokens = isThinkingModel ? 16384 : 4096;

      return {
        model,
        max_tokens: maxTokens,
        stream: true,
        // Extended thinking — Anthropic requires explicit opt-in
        ...(isThinkingModel ? {
          thinking: { type: 'enabled', budget_tokens: 10000 },
        } : {}),
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
      };
    },
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
    buildBody: (model, messages) => {
      // Detect reasoning models (o1, o3, o3-mini)
      const isReasoningModel = /^o[1-9]|^o3/.test(model);

      return {
      model,
      stream: true,
      stream_options: { include_usage: true },
      // Reasoning models: set effort level
      ...(isReasoningModel ? {
        reasoning_effort: 'medium',
      } : {}),
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
    };
    },
    parseStream: (line) => {
      if (!line.startsWith('data: ')) return null;
      const data = line.slice(6).trim();
      if (data === '[DONE]') return { type: 'done' };
      try {
        const parsed = JSON.parse(data);
        if (parsed.choices?.[0]?.delta?.content) {
          return { type: 'content', text: parsed.choices[0].delta.content };
        }
        // OpenAI reasoning content (o1, o3 models)
        if (parsed.choices?.[0]?.delta?.reasoning_content) {
          return { type: 'thinking', text: parsed.choices[0].delta.reasoning_content };
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
      // Enable thinking for Flash and Pro models
      generationConfig: {
        thinkingConfig: { includeThoughts: true },
      },
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
          let thinkingText = '';
          let contentText = '';
          let imageText = '';
          let toolCall: { name: string; args: Record<string, unknown> } | null = null;

          for (const part of parts) {
            // Google thinking/thought parts
            if (part.thought === true && part.text) {
              thinkingText += part.text;
              continue;
            }
            if (part.functionCall) {
              toolCall = {
                name: part.functionCall.name,
                args: part.functionCall.args ?? {},
              };
              continue;
            }
            if (part.text) {
              contentText += part.text;
              continue;
            }
            if (part.inlineData) {
              // Gemini returns images as base64 inlineData
              const mime = part.inlineData.mimeType || 'image/png';
              const b64 = part.inlineData.data;
              imageText += `\n![Generated Image](data:${mime};base64,${b64})\n`;
            }
          }

          if (contentText || imageText) {
            return { type: 'content', text: `${contentText}${imageText}` };
          }
          if (toolCall) {
            return {
              type: 'tool_call',
              toolName: toolCall.name,
              toolId: toolCall.name + '-' + Date.now(),
              args: toolCall.args,
            };
          }
          if (thinkingText) {
            return { type: 'thinking', text: thinkingText };
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

function approvalRiskForCommand(command: string): ApprovalRisk {
  const normalized = command.trim().toLowerCase();
  if (/(^|\s)(rm\s+-rf|sudo|chmod\s+777|git\s+push\b.*--force|mkfs|dd\s+if=|shutdown|reboot)/.test(normalized)) {
    return 'high';
  }
  if (/(npm|pnpm|yarn|docker|kubectl|vercel|netlify|git\s+checkout|git\s+clean)/.test(normalized)) {
    return 'medium';
  }
  return 'low';
}

function approvalRiskForTool(toolName: string, args: Record<string, unknown>): ApprovalRisk {
  if (toolName === 'run_terminal_command') {
    return approvalRiskForCommand(String(args.command || ''));
  }
  if (toolName === 'delete_file') {
    return 'high';
  }
  if (toolName === 'write_file' || toolName === 'edit_file' || toolName === 'create_pull_request') {
    return 'medium';
  }
  return 'low';
}

function approvalTitleForTool(toolName: string) {
  if (toolName === 'run_terminal_command') return 'Run terminal command';
  if (toolName === 'write_file') return 'Write file';
  if (toolName === 'edit_file') return 'Edit file';
  if (toolName === 'delete_file') return 'Delete file';
  if (toolName === 'create_github_issue') return 'Create GitHub issue';
  if (toolName === 'create_pull_request') return 'Create pull request';
  return `Execute ${toolName}`;
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

  const { model, provider, messages: rawMessages, approvedTools: approvedToolsList, disableTools, toolOverrides: rawToolOverrides } = body as {
    model: string;
    provider: Provider;
    messages: Message[];
    approvedTools?: string[];
    disableTools?: boolean;
    toolOverrides?: Record<string, Record<string, unknown>>;
  };
  const approvedTools = new Set(approvedToolsList ?? []);
  const toolOverrides = rawToolOverrides ?? {};
  const tabId = request.headers.get('x-tab-id')?.trim() || '';
  const { repoRoot: scopedRepoRoot } = await resolveRepoScopeFromHeaders(request.headers);

  // Inject workspace context as system prompt (Phase 1)
  let systemPrompt = scopedRepoRoot
    ? buildSystemPrompt(getWorkspaceContext(scopedRepoRoot))
    : buildUnscopedSystemPrompt();

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
  const upstreamBody = config.buildBody(model, messages) as Record<string, unknown>;
  if (disableTools) {
    delete upstreamBody.tools;
  }

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
          const maxLoops = 8; // Safety limit — allows multi-step tool chains
          const allSources: { title: string; url?: string; path?: string }[] = [];

          // Tool call loop — execute tools and send results back to model
          while (toolCalls.length > 0 && loopCount < maxLoops) {
            loopCount++;
            const toolResultParts: string[] = [];

            for (const tc of toolCalls) {
              const toolOverride = toolOverrides[tc.name];
              if (toolOverride && typeof toolOverride === 'object') {
                tc.args = { ...tc.args, ...toolOverride };
              }
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

                // Build rich summary based on tool type
                let summary = `Execute ${tc.name}`;
                let diff: { before?: string; after?: string; path?: string } | undefined;

                if (tc.name === 'create_github_issue') {
                  summary = `Create issue: "${tc.args.title}" in ${tc.args.repo}`;
                } else if (tc.name === 'create_pull_request') {
                  summary = `Create PR: "${tc.args.title}" on branch ${tc.args.branch}`;
                } else if (tc.name === 'run_terminal_command') {
                  summary = `Run command: ${cmd}`;
                } else if (tc.name === 'write_file') {
                  const filePath = String(tc.args.path || '');
                  const content = String(tc.args.content || '');
                  const lineCount = content.split('\n').length;
                  // Check if file exists for before/after diff
                  try {
                    const { readFileSync, existsSync } = await import('node:fs');
                    const { join } = await import('node:path');
                    if (!scopedRepoRoot) {
                      throw new Error('No scoped repo');
                    }
                    const fullPath = join(scopedRepoRoot, filePath);
                    if (existsSync(fullPath)) {
                      const before = readFileSync(fullPath, 'utf-8');
                      summary = `Overwrite ${filePath} (${lineCount} lines)`;
                      diff = { before, after: content, path: filePath };
                    } else {
                      summary = `Create new file: ${filePath} (${lineCount} lines)`;
                      diff = { before: '', after: content, path: filePath };
                    }
                  } catch {
                    summary = `Write to ${filePath} (${lineCount} lines)`;
                  }
                } else if (tc.name === 'edit_file') {
                  const filePath = String(tc.args.path || '');
                  const oldText = String(tc.args.oldText || '');
                  const newText = String(tc.args.newText || '');
                  summary = `Edit ${filePath}`;
                  diff = { before: oldText, after: newText, path: filePath };
                } else if (tc.name === 'delete_file') {
                  summary = `Delete file: ${tc.args.path}`;
                }

                const approval = tabId
                  ? createApproval({
                      source: 'llm-chat',
                      runtime: 'chat',
                      agent: 'Chat',
                      sessionKey: `llm-chat:${tabId}`,
                      title: approvalTitleForTool(tc.name),
                      description: summary,
                      summary,
                      toolName: tc.name,
                      args: tc.args,
                      command: cmd || undefined,
                      editable: tc.name === 'run_terminal_command',
                      diff,
                      risk: approvalRiskForTool(tc.name, tc.args),
                      metadata: {
                        Model: model,
                        Tool: tc.name,
                        ...(cmd ? { Command: cmd } : {}),
                        ...(!cmd && tc.args.path ? { Path: String(tc.args.path) } : {}),
                      },
                      continuation: {
                        kind: 'llm-chat',
                        tabId,
                        model,
                        provider,
                        messages: rawMessages,
                        approvedTools: [...approvedTools],
                      },
                    })
                  : null;

                enqueue(JSON.stringify({
                  type: 'approval_required',
                  id: approval?.id,
                  name: tc.name,
                  args: tc.args,
                  editable: tc.name === 'run_terminal_command',
                  summary,
                  diff,
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
              const result: ToolResult = await executeTool(tc.name, tc.args, scopedRepoRoot);

              if (result.sources) {
                allSources.push(...result.sources);
              }

              enqueue(JSON.stringify({ type: 'tool_result', name: tc.name, status: 'done', preview: result.content.slice(0, 200) }));

              toolResultParts.push(`[${tc.name}] ${result.content}`);
            }

            // Combine ALL tool results from this turn into one clean message pair
            const toolNames = toolCalls.map(tc => tc.name).join(', ');
            messages.push(
              { role: 'assistant', content: `I used the following tools: ${toolNames}` },
              { role: 'user', content: `Tool results:\n\n${toolResultParts.join('\n\n---\n\n')}\n\nBased on these results, provide your complete response to the user. Do not call more tools unless absolutely necessary.` }
            );

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
