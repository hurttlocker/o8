import { spawn } from 'child_process';
import os from 'os';
import path from 'path';

const CLAUDE_BIN = process.env.O8_CLAUDE_CODE_BIN || process.env.CLAUDE_BIN || path.join(os.homedir(), '.local', 'bin', 'claude');

interface SendRequest {
  message: string;
  cwd?: string;
  sessionId?: string;
  model?: string;
  continueLatest?: boolean;
  planMode?: boolean;
  bypassPermissions?: boolean;
}

function usageFromClaude(input: unknown) {
  if (!input || typeof input !== 'object') return undefined;
  const usage = input as { input_tokens?: unknown; output_tokens?: unknown };
  const next = {
    inputTokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : 0,
    outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : 0,
  };
  return next.inputTokens > 0 || next.outputTokens > 0 ? next : undefined;
}

export async function handleClaudeCodeSend(req: Request) {
  const body = (await req.json()) as SendRequest;
  const { message, cwd, sessionId, model, continueLatest, planMode } = body;
  const bypassPermissions = body.bypassPermissions ?? true;

  if (!message?.trim()) {
    return new Response(JSON.stringify({ error: 'Message is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const args = [
    '-p', message,
    '--output-format', 'stream-json',
    '--verbose',
  ];

  if (planMode) {
    args.push('--permission-mode', 'plan');
  } else if (bypassPermissions) {
    args.push('--dangerously-skip-permissions');
  }

  if (sessionId) {
    args.push('--resume', sessionId);
  } else if (cwd && continueLatest !== false) {
    args.push('--continue');
  }

  if (model) {
    args.push('--model', model);
  }

  const expandedCwd = cwd?.replace(/^~/, os.homedir());
  const workingDir = expandedCwd || process.cwd();

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const child = spawn(CLAUDE_BIN, args, {
        cwd: workingDir,
        env: { ...process.env, FORCE_COLOR: '0', O8_MANAGED_SESSION: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let fullResponse = '';
      let sessionUuid = '';
      let emittedDone = false;

      child.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString();

        for (const line of text.split('\n').filter(Boolean)) {
          try {
            const event = JSON.parse(line) as Record<string, unknown>;

            if (event.type === 'system' && event.session_id) {
              sessionUuid = event.session_id as string;
            }

            if (event.type === 'assistant') {
              const message = event.message as {
                content?: Array<{ type?: string; text?: string; name?: string; input?: unknown }>;
                usage?: unknown;
              } | undefined;
              const content = Array.isArray(message?.content) ? message.content : [];
              const textParts: string[] = [];
              for (const part of content) {
                if (part?.type === 'text' && part.text) {
                  textParts.push(part.text);
                }
                if (part?.type === 'tool_use' && part.name) {
                  controller.enqueue(encoder.encode(
                    `data: ${JSON.stringify({ type: 'tool_call', name: part.name, status: 'running', args: part.input })}\n\n`,
                  ));
                }
              }
              const mergedText = textParts.join('\n').trim();
              if (mergedText && !fullResponse) {
                fullResponse += mergedText;
                controller.enqueue(encoder.encode(
                  `data: ${JSON.stringify({ type: 'delta', text: mergedText })}\n\n`,
                ));
              }
              const usage = usageFromClaude(message?.usage);
              if (usage) {
                controller.enqueue(encoder.encode(
                  `data: ${JSON.stringify({ type: 'usage', ...usage })}\n\n`,
                ));
              }
            }

            if (event.type === 'content_block_delta') {
              const delta = event.delta as { type?: string; text?: string } | undefined;
              if (delta?.type === 'thinking_delta' && typeof (delta as { thinking?: unknown }).thinking === 'string') {
                controller.enqueue(encoder.encode(
                  `data: ${JSON.stringify({ type: 'thinking', text: (delta as { thinking: string }).thinking })}\n\n`,
                ));
                continue;
              }
              if (delta?.text) {
                fullResponse += delta.text;
                controller.enqueue(encoder.encode(
                  `data: ${JSON.stringify({ type: 'delta', text: delta.text })}\n\n`,
                ));
              }
            }

            if (event.type === 'content_block_start') {
              const contentBlock = event.content_block as { type?: string; name?: string; input?: unknown } | undefined;
              if (contentBlock?.type === 'tool_use') {
                controller.enqueue(encoder.encode(
                  `data: ${JSON.stringify({ type: 'tool_call', name: contentBlock.name, status: 'running', args: contentBlock.input })}\n\n`,
                ));
              }
              if (contentBlock?.type === 'thinking') {
                controller.enqueue(encoder.encode(
                  `data: ${JSON.stringify({ type: 'thinking', text: '' })}\n\n`,
                ));
              }
            }

            if ((event.type === 'message_stop' || event.type === 'result') && !emittedDone) {
              const resultText = (event.result as string) ?? fullResponse;
              const usage = usageFromClaude(event.usage);
              if (usage) {
                controller.enqueue(encoder.encode(
                  `data: ${JSON.stringify({ type: 'usage', ...usage, costUsd: event.total_cost_usd ?? event.cost_usd ?? undefined })}\n\n`,
                ));
              }
              controller.enqueue(encoder.encode(
                `data: ${JSON.stringify({
                  type: 'done',
                  text: resultText,
                  sessionId: sessionUuid || (event.session_id as string) || undefined,
                  costUsd: event.total_cost_usd ?? event.cost_usd ?? undefined,
                  duration: event.duration_ms ?? undefined,
                })}\n\n`,
              ));
              emittedDone = true;
            }
          } catch {
            // Partial or non-JSON lines are ignored until Claude emits complete JSONL.
          }
        }
      });

      child.stderr.on('data', (chunk: Buffer) => {
        const errText = chunk.toString().trim();
        if (errText) {
          controller.enqueue(encoder.encode(
            `data: ${JSON.stringify({ type: 'error', text: errText })}\n\n`,
          ));
        }
      });

      child.on('close', (code) => {
        controller.enqueue(encoder.encode(
          `data: ${JSON.stringify({
            type: 'close',
            exitCode: code,
            text: fullResponse,
            sessionId: sessionUuid || undefined,
          })}\n\n`,
        ));
        controller.close();
      });

      child.on('error', (err) => {
        controller.enqueue(encoder.encode(
          `data: ${JSON.stringify({ type: 'error', text: err.message })}\n\n`,
        ));
        controller.close();
      });

      child.stdin.end();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-store',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
