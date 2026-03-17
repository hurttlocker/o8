import { NextRequest } from 'next/server';
import { spawn } from 'child_process';
import os from 'os';
import path from 'path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CODEX_BIN = path.join(os.homedir(), '.npm-global', 'bin', 'codex');

interface SendRequest {
  message: string;
  cwd?: string;
  threadId?: string; // Codex thread UUID for resume
  model?: string;
}

/**
 * POST /api/codex/send
 *
 * Sends a message to Codex CLI in exec mode and streams the response.
 * Uses --json for JSONL event streaming.
 *
 * If threadId is provided, resumes that conversation via `codex exec resume`.
 * Otherwise starts a new exec session in the given cwd.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json()) as SendRequest;
  const { message, cwd, threadId, model } = body;

  if (!message?.trim()) {
    return new Response(JSON.stringify({ error: 'Message is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Expand tilde in workspace paths
  const expandedCwd = cwd?.replace(/^~/, os.homedir());
  const workingDir = expandedCwd || process.cwd();

  // Build command args
  let args: string[];
  if (threadId) {
    // Resume existing conversation
    args = ['exec', 'resume', threadId, message, '--json', '--dangerously-bypass-approvals-and-sandbox'];
  } else {
    // New conversation
    args = ['exec', message, '--json', '--dangerously-bypass-approvals-and-sandbox'];
  }

  if (model) {
    args.push('--model', model);
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const child = spawn(CODEX_BIN, args, {
        cwd: workingDir,
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let fullResponse = '';
      let capturedThreadId = '';

      child.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString();

        for (const line of text.split('\n').filter(Boolean)) {
          try {
            const event = JSON.parse(line) as Record<string, unknown>;

            // Capture thread ID
            if (event.type === 'thread.started' && event.thread_id) {
              capturedThreadId = event.thread_id as string;
              controller.enqueue(encoder.encode(
                `data: ${JSON.stringify({ type: 'session', threadId: capturedThreadId })}\n\n`
              ));
            }

            // Agent message completed — the actual response text
            if (event.type === 'item.completed') {
              const item = event.item as { type?: string; text?: string; id?: string } | undefined;
              if (item?.type === 'agent_message' && item.text) {
                fullResponse += item.text;
                controller.enqueue(encoder.encode(
                  `data: ${JSON.stringify({ type: 'delta', text: item.text })}\n\n`
                ));
              }

              // Tool calls
              if (item?.type === 'tool_call') {
                const toolItem = item as unknown as { name?: string };
                if (toolItem.name) {
                  controller.enqueue(encoder.encode(
                    `data: ${JSON.stringify({ type: 'tool', name: toolItem.name })}\n\n`
                  ));
                }
              }
            }

            // Turn completed — usage info
            if (event.type === 'turn.completed') {
              const usage = event.usage as { input_tokens?: number; output_tokens?: number } | undefined;
              controller.enqueue(encoder.encode(
                `data: ${JSON.stringify({
                  type: 'done',
                  text: fullResponse,
                  threadId: capturedThreadId || undefined,
                  inputTokens: usage?.input_tokens,
                  outputTokens: usage?.output_tokens,
                })}\n\n`
              ));
            }
          } catch {
            // Not JSON or partial — skip
          }
        }
      });

      child.stderr.on('data', (chunk: Buffer) => {
        const errText = chunk.toString().trim();
        // Filter out MCP connection errors (noisy but non-fatal)
        if (errText && !errText.includes('rmcp::transport') && !errText.includes('worker quit')) {
          controller.enqueue(encoder.encode(
            `data: ${JSON.stringify({ type: 'error', text: errText })}\n\n`
          ));
        }
      });

      child.on('close', (code) => {
        controller.enqueue(encoder.encode(
          `data: ${JSON.stringify({
            type: 'close',
            exitCode: code,
            text: fullResponse,
            threadId: capturedThreadId || undefined,
          })}\n\n`
        ));
        controller.close();
      });

      child.on('error', (err) => {
        controller.enqueue(encoder.encode(
          `data: ${JSON.stringify({ type: 'error', text: err.message })}\n\n`
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
