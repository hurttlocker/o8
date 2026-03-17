import { NextRequest } from 'next/server';
import { spawn } from 'child_process';
import path from 'path';
import os from 'os';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CLAUDE_BIN = path.join(os.homedir(), '.local', 'bin', 'claude');

interface SendRequest {
  message: string;
  cwd?: string;
  sessionId?: string; // Claude Code session UUID for --resume
  model?: string;
}

/**
 * POST /api/claude-code/send
 *
 * Sends a message to Claude Code CLI in print mode and streams the response.
 * Uses --output-format stream-json for real-time token streaming.
 *
 * If sessionId is provided, resumes that conversation.
 * Otherwise starts a new session in the given cwd.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json()) as SendRequest;
  const { message, cwd, sessionId, model } = body;

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
    '--dangerously-skip-permissions',
  ];

  if (sessionId) {
    args.push('--resume', sessionId);
  } else if (cwd) {
    // --continue resumes the most recent conversation in the cwd
    args.push('--continue');
  }

  if (model) {
    args.push('--model', model);
  }

  // Expand tilde in workspace paths from fleet API
  const expandedCwd = cwd?.replace(/^~/, os.homedir());
  const workingDir = expandedCwd || process.cwd();

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const child = spawn(CLAUDE_BIN, args, {
        cwd: workingDir,
        env: { ...process.env, FORCE_COLOR: '0' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let fullResponse = '';
      let sessionUuid = '';

      child.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString();

        // Parse stream-json lines — each line is a JSON object
        for (const line of text.split('\n').filter(Boolean)) {
          try {
            const event = JSON.parse(line) as Record<string, unknown>;

            // Extract session ID from init message
            if (event.type === 'system' && event.session_id) {
              sessionUuid = event.session_id as string;
            }

            // Content block delta — the actual text tokens
            if (event.type === 'content_block_delta') {
              const delta = event.delta as { type?: string; text?: string } | undefined;
              if (delta?.text) {
                fullResponse += delta.text;
                controller.enqueue(encoder.encode(
                  `data: ${JSON.stringify({ type: 'delta', text: delta.text })}\n\n`
                ));
              }
            }

            // Assistant message complete
            if (event.type === 'message_stop' || event.type === 'result') {
              const resultText = (event.result as string) ?? fullResponse;
              controller.enqueue(encoder.encode(
                `data: ${JSON.stringify({
                  type: 'done',
                  text: resultText,
                  sessionId: sessionUuid || (event.session_id as string) || undefined,
                  costUsd: event.cost_usd ?? undefined,
                  duration: event.duration_ms ?? undefined,
                })}\n\n`
              ));
            }

            // Tool use events — surface what Claude Code is doing
            if (event.type === 'tool_use' || event.type === 'content_block_start') {
              const contentBlock = event.content_block as { type?: string; name?: string } | undefined;
              if (contentBlock?.type === 'tool_use') {
                controller.enqueue(encoder.encode(
                  `data: ${JSON.stringify({ type: 'tool', name: contentBlock.name })}\n\n`
                ));
              }
            }
          } catch {
            // Not JSON or partial line — skip
          }
        }
      });

      child.stderr.on('data', (chunk: Buffer) => {
        const errText = chunk.toString().trim();
        if (errText) {
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
            sessionId: sessionUuid || undefined,
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

      // Write nothing to stdin and close it
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
