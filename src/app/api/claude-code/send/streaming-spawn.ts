import { spawn } from 'child_process';
import os from 'os';
import path from 'path';
import { createClaudeCodeStreamJsonParser } from '@/lib/claude-code/stream-json-parser';

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

      const parser = createClaudeCodeStreamJsonParser();
      const enqueueEvent = (event: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      child.stdout.on('data', (chunk: Buffer) => {
        for (const event of parser.pushChunk(chunk.toString('utf8'))) {
          enqueueEvent(event);
        }
      });

      child.stderr.on('data', (chunk: Buffer) => {
        const errText = chunk.toString().trim();
        if (errText) {
          enqueueEvent({ type: 'error', text: errText });
        }
      });

      child.on('close', (code) => {
        for (const event of parser.flush()) {
          enqueueEvent(event);
        }
        const state = parser.getState();
        enqueueEvent({
          type: 'close',
          exitCode: code,
          text: state.fullResponse,
          sessionId: state.sessionId || undefined,
        });
        controller.close();
      });

      child.on('error', (err) => {
        enqueueEvent({ type: 'error', text: err.message });
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
