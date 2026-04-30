/**
 * Sonnet adapter for the Cortex Q&A layer.
 *
 * Resolves the Sonnet provider in priority order:
 *   1. Claude Code CLI   — users with a Claude Max / Pro subscription (most users)
 *   2. ANTHROPIC_API_KEY — power users with a direct API key
 *   3. Gemini Flash      — fallback when neither is available
 *
 * Uses `--print` mode for one-shot CLI invocations so these calls never
 * pollute the orchestrator session registry or the runtime adapter system.
 * The working directory is os.tmpdir() so the invocation doesn't pick up
 * any project-level .claude/ config.
 */

import 'server-only';

import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ── Provider tier ─────────────────────────────────────────────────────────────

export type SonnetTier = 'cli' | 'api' | 'flash';

interface TierResult {
  tier: SonnetTier;
  claudeBin?: string;
}

let cachedTier: TierResult | null = null;

/**
 * Resolve the claude binary via which + login-shell, mirroring the pattern
 * in src/lib/runtimes/shared/cli-resolver.ts but kept lightweight here
 * since we only need the binary path, not full versioned metadata.
 */
async function resolveClaudeBinForQa(): Promise<string | null> {
  // 1. Explicit env override (same keys the runtime adapter honours).
  for (const envKey of ['O8_CLAUDE_CODE_BIN', 'CLAUDE_BIN']) {
    const val = process.env[envKey];
    if (val) return val;
  }

  // 2. which claude
  try {
    const { stdout } = await execFileAsync('which', ['claude'], { timeout: 3_000 });
    const found = stdout.trim();
    if (found) return found;
  } catch {
    // not on PATH — try login shell
  }

  // 3. Login-shell probe (catches nvm/fnm/volta binaries).
  const userShell = process.env.SHELL ?? 'zsh';
  for (const sh of [userShell, 'zsh', 'bash', 'sh']) {
    try {
      const { stdout } = await execFileAsync(sh, ['-l', '-c', 'command -v claude'], {
        timeout: 10_000,
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      });
      const found = stdout.trim();
      if (found) return found;
    } catch {
      // shell not available or command failed
    }
  }

  return null;
}

/**
 * Detect and cache the active Sonnet provider tier. Called once per process.
 */
async function detectTier(): Promise<TierResult> {
  if (cachedTier) return cachedTier;

  // Test 1: Claude Code CLI available?
  const claudeBin = await resolveClaudeBinForQa();
  if (claudeBin) {
    // Quick sanity-check: `claude --version` must succeed.
    try {
      await execFileAsync(claudeBin, ['--version'], {
        timeout: 5_000,
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      });
      cachedTier = { tier: 'cli', claudeBin };
      console.log(`[qa] Sonnet provider: CLI (${claudeBin})`);
      return cachedTier;
    } catch {
      // Binary found but can't be executed — fall through.
      console.warn(`[qa] Claude CLI found at ${claudeBin} but --version failed — skipping.`);
    }
  }

  // Test 2: ANTHROPIC_API_KEY present?
  if (process.env.ANTHROPIC_API_KEY?.trim()) {
    cachedTier = { tier: 'api' };
    console.log('[qa] Sonnet provider: ANTHROPIC_API_KEY');
    return cachedTier;
  }

  // Test 3: Flash fallback.
  cachedTier = { tier: 'flash' };
  console.warn('[qa] no Sonnet path available, degrading to Flash');
  return cachedTier;
}

/** Force re-detection on next call (useful for testing). */
export function resetSonnetProviderCache(): void {
  cachedTier = null;
}

// ── CLI streaming parser ──────────────────────────────────────────────────────

/**
 * Parse a stream-json output line from the Claude CLI (streaming mode).
 * Returns text from assistant events; null for all other event types.
 *
 * With --verbose the relevant event shapes are:
 *   - content_block_delta { delta: { type: 'text_delta', text } }   — API streaming
 *   - assistant { message: { content: [{ type: 'text', text }] } }  — verbose fallback
 *
 * We skip `result` events here to avoid duplicating text that already came
 * through the assistant event.
 */
function extractCliStreamingText(line: string): string | null {
  if (!line.trim()) return null;
  try {
    const evt = JSON.parse(line) as Record<string, unknown>;

    // API streaming delta — { type: 'content_block_delta', delta: { type: 'text_delta', text } }
    if (
      evt['type'] === 'content_block_delta' &&
      typeof evt['delta'] === 'object' &&
      evt['delta'] !== null
    ) {
      const delta = evt['delta'] as Record<string, unknown>;
      if (delta['type'] === 'text_delta' && typeof delta['text'] === 'string') {
        return delta['text'];
      }
    }

    // Verbose assistant event — { type: 'assistant', message: { content: [{ type: 'text', text }] } }
    if (evt['type'] === 'assistant' && typeof evt['message'] === 'object' && evt['message'] !== null) {
      const msg = evt['message'] as Record<string, unknown>;
      const content = msg['content'];
      if (Array.isArray(content)) {
        const parts: string[] = [];
        for (const block of content) {
          if (
            typeof block === 'object' &&
            block !== null &&
            (block as Record<string, unknown>)['type'] === 'text' &&
            typeof (block as Record<string, unknown>)['text'] === 'string'
          ) {
            parts.push((block as Record<string, unknown>)['text'] as string);
          }
        }
        if (parts.length > 0) return parts.join('');
      }
    }
  } catch {
    // not JSON — skip
  }
  return null;
}

/**
 * Parse a stream-json output line for the non-streaming (batch) path.
 * Extracts text only from the terminal `result` event, which contains the
 * complete response text. Skips assistant events to avoid double-counting.
 */
function extractCliResultText(line: string): string | null {
  if (!line.trim()) return null;
  try {
    const evt = JSON.parse(line) as Record<string, unknown>;
    if (evt['type'] === 'result' && typeof evt['result'] === 'string') {
      return evt['result'];
    }
  } catch {
    // not JSON — skip
  }
  return null;
}

/**
 * Full text extractor for non-streaming CLI output.
 * Scans all lines for the terminal `result` event and returns its text.
 */
function extractCliFullText(output: string): string {
  const lines = output.split('\n').filter(Boolean);
  for (const line of lines) {
    const text = extractCliResultText(line);
    if (text !== null) return text;
  }
  return '';
}

// ── callSonnet public API ─────────────────────────────────────────────────────

interface SonnetMessages {
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** CLI subprocess timeout in ms. Default 60_000. Long prompts (e.g. indexer
   * distillation of 6KB+ comments) need more headroom. */
  timeoutMs?: number;
}

/** Non-streaming: returns the full response string. */
export async function callSonnet(
  opts: SonnetMessages & { stream?: false },
): Promise<{ text: string; tier: SonnetTier }>;

/** Streaming: returns an async iterable of token strings + tier. */
export async function callSonnet(
  opts: SonnetMessages & { stream: true },
): Promise<{ tokens: AsyncIterable<string>; tier: SonnetTier }>;

export async function callSonnet(
  opts: SonnetMessages & { stream?: boolean },
): Promise<{ text: string; tier: SonnetTier } | { tokens: AsyncIterable<string>; tier: SonnetTier }> {
  const tier = await detectTier();

  if (tier.tier === 'cli') {
    return callSonnetCli(opts, tier.claudeBin!);
  }

  if (tier.tier === 'api') {
    return callSonnetApi(opts);
  }

  // Flash fallback.
  return callFlashFallback(opts);
}

// ── CLI provider ──────────────────────────────────────────────────────────────

/**
 * Build the full user message combining system prompt + messages.
 * We pass system content as part of the prompt since `--print` doesn't
 * accept a separate system flag via CLI.
 */
function buildCliPrompt(system: string, messages: SonnetMessages['messages']): string {
  const userMsg = messages[messages.length - 1]?.content ?? '';
  // Prepend system as context block so the model respects it.
  return `<system>\n${system}\n</system>\n\n${userMsg}`;
}

async function callSonnetCli(
  opts: SonnetMessages & { stream?: boolean },
  claudeBin: string,
): Promise<{ text: string; tier: SonnetTier } | { tokens: AsyncIterable<string>; tier: SonnetTier }> {
  const prompt = buildCliPrompt(opts.system, opts.messages);

  // Always use tmpdir so no project .claude/ config is inherited.
  const cwd = os.tmpdir();

  // --verbose is required when combining --print and --output-format stream-json.
  // Prompt is fed via stdin so multi-line content never gets mangled by shell arg
  // parsing (positional args with newlines confuse the CLI's argv parser).
  const cliArgs = [
    '--print',
    '--verbose',
    '--dangerously-skip-permissions',
    '--output-format', 'stream-json',
    '--model', 'claude-sonnet-4-6',
  ];

  const env = {
    ...process.env,
    FORCE_COLOR: '0',
    NO_COLOR: '1',
  };

  if (opts.stream) {
    // Streaming: return an async generator that yields tokens as the CLI writes them.
    const tokens = (async function* (): AsyncIterable<string> {
      const { spawn } = await import('node:child_process');
      const child = spawn(claudeBin, cliArgs, {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Write prompt to stdin, then close so the CLI knows input is done.
      child.stdin!.write(prompt, 'utf-8');
      child.stdin!.end();

      let lineBuffer = '';
      const decoder = new TextDecoder();

      for await (const chunk of child.stdout!) {
        const str = typeof chunk === 'string' ? chunk : decoder.decode(chunk as Buffer, { stream: true });
        lineBuffer += str;
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() ?? '';
        for (const line of lines) {
          const text = extractCliStreamingText(line);
          if (text) yield text;
        }
      }

      // Flush remaining buffer.
      if (lineBuffer.trim()) {
        const text = extractCliStreamingText(lineBuffer);
        if (text) yield text;
      }

      // Wait for exit so caller can detect errors.
      await new Promise<void>((resolve) => child.on('close', () => resolve()));
    })();

    return { tokens, tier: 'cli' };
  }

  // Non-streaming: spawn, write prompt to stdin, collect stdout to completion.
  // Using spawn (not execFileAsync) so we can write to stdin — execFile's type
  // definition doesn't expose the `input` option even though the runtime accepts it.
  try {
    const text = await new Promise<string>((resolve, reject) => {
      const { spawn: spawnSync } = require('node:child_process') as typeof import('node:child_process');
      const child = spawnSync(claudeBin, cliArgs, {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      child.stdin!.write(prompt, 'utf-8');
      child.stdin!.end();

      let stdout = '';
      let stderr = '';
      child.stdout!.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

      const timeoutMs = opts.timeoutMs ?? 60_000;
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`[qa] Claude CLI timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);

      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0 && stdout.trim() === '') {
          reject(new Error(`[qa] Claude CLI exited with code ${code}: ${stderr.slice(0, 400)}`));
        } else {
          resolve(stdout);
        }
      });
    });

    return { text: extractCliFullText(text), tier: 'cli' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`[qa] Claude CLI invocation failed: ${message}`);
  }
}

// ── API provider ──────────────────────────────────────────────────────────────

async function callSonnetApi(
  opts: SonnetMessages & { stream?: boolean },
): Promise<{ text: string; tier: SonnetTier } | { tokens: AsyncIterable<string>; tier: SonnetTier }> {
  const apiKey = process.env.ANTHROPIC_API_KEY!;

  const body = {
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: opts.system,
    messages: opts.messages,
    stream: Boolean(opts.stream),
  };

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok || !res.body) {
    const errText = await res.text().catch(() => '');
    throw new Error(`[qa] Anthropic API error ${res.status}: ${errText.slice(0, 200)}`);
  }

  if (!opts.stream) {
    const json = await res.json() as { content?: Array<{ type?: string; text?: string }> };
    const text = json.content?.find((b) => b.type === 'text')?.text ?? '';
    return { text, tier: 'api' };
  }

  // Streaming via SSE.
  const tokens = (async function* (): AsyncIterable<string> {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let lineBuffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        lineBuffer += line + '\n';
        if (line === '') {
          const block = lineBuffer;
          lineBuffer = '';
          if (!block.includes('data: ')) continue;
          const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
          if (!dataLine) continue;
          const raw = dataLine.slice(6).trim();
          if (raw === '[DONE]') return;
          try {
            const evt = JSON.parse(raw) as {
              type?: string;
              delta?: { type?: string; text?: string };
            };
            if (
              evt.type === 'content_block_delta' &&
              evt.delta?.type === 'text_delta' &&
              evt.delta.text
            ) {
              yield evt.delta.text;
            }
          } catch {
            // ignore parse errors mid-stream
          }
        }
      }
    }
  })();

  return { tokens, tier: 'api' };
}

// ── Flash fallback ────────────────────────────────────────────────────────────

async function callFlashFallback(
  opts: SonnetMessages & { stream?: boolean },
): Promise<{ text: string; tier: SonnetTier } | { tokens: AsyncIterable<string>; tier: SonnetTier }> {
  const apiKey =
    process.env.GOOGLE_AI_API_KEY ??
    process.env.GOOGLE_GENERATIVE_AI_API_KEY ??
    process.env.GEMINI_API_KEY;

  if (!apiKey) {
    const msg = 'No LLM provider available (no Claude CLI, no ANTHROPIC_API_KEY, no Gemini key).';
    if (opts.stream) {
      async function* singleToken(): AsyncIterable<string> { yield msg; }
      return { tokens: singleToken(), tier: 'flash' };
    }
    return { text: msg, tier: 'flash' };
  }

  const userMsg = opts.messages[opts.messages.length - 1]?.content ?? '';
  const combinedPrompt = `${opts.system}\n\n${userMsg}`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: combinedPrompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 1024 },
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    const msg = `Answer unavailable (Flash API error ${res.status}).`;
    console.warn(`[qa] Flash fallback error ${res.status}: ${errText.slice(0, 200)}`);
    if (opts.stream) {
      async function* singleToken(): AsyncIterable<string> { yield msg; }
      return { tokens: singleToken(), tier: 'flash' };
    }
    return { text: msg, tier: 'flash' };
  }

  const json = await res.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text ?? '';

  if (opts.stream) {
    async function* singleToken(): AsyncIterable<string> { if (text) yield text; }
    return { tokens: singleToken(), tier: 'flash' };
  }

  return { text, tier: 'flash' };
}
