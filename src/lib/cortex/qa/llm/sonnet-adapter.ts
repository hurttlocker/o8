/**
 * Sonnet adapter for the Cortex Q&A layer.
 *
 * Resolves the Sonnet provider in priority order:
 *   1. Claude Code CLI   — users with a Claude Max / Pro subscription (most users)
 *   2. ANTHROPIC_API_KEY — power users with a direct API key
 *   3. Gemini Flash      — fallback when neither is available
 *
 * CLI path uses the `claude --input-format stream-json` REPL spawn (no `-p` /
 * `--print`) — the same shape the in-app chat tab uses — so calls bill against
 * the user's Claude Code MAX subscription pool, NOT the gated Agent SDK pool
 * that `--print` taps. Shared spawn helper lives in
 * `src/lib/claude-code/one-shot-repl.ts`. See #1124 for the SDK-billing trap
 * and #1066 for the original REPL migration.
 *
 * Working directory is os.tmpdir() so the invocation doesn't pick up any
 * project-level .claude/ config.
 */

import 'server-only';

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { askClaudeOneShot } from '@/lib/claude-code/one-shot-repl';

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

  // June 15 2026 — `claude --print` bills against the user's Agent SDK credit
  // pool. Gated behind the same toggle as the in-app orchestrator chat. When
  // off, skip the CLI tier and fall through to API key (their own pay-per-
  // token, unaffected) or Flash. Dynamic import keeps the dependency graph
  // one-way at compile time.
  const { resolveInAppOrchestratorEnabledSync } = await import('@/lib/operator/defaults');
  const cliAllowed = resolveInAppOrchestratorEnabledSync();

  // Test 1: Claude Code CLI available?
  if (cliAllowed) {
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

// ── CLI provider (REPL stream-json — subscription-billed) ───────────────────

/**
 * Build the prompt for the REPL one-shot. System content is prepended as a
 * `<system>...</system>` block since the one-shot frame only carries a `user`
 * message — keeping the same shape the prior `--print` path used so existing
 * eval baselines stay comparable.
 */
function buildCliPrompt(system: string, messages: SonnetMessages['messages']): string {
  const userMsg = messages[messages.length - 1]?.content ?? '';
  return `<system>\n${system}\n</system>\n\n${userMsg}`;
}

/**
 * Invoke Sonnet via the REPL one-shot helper. Subscription-billed (no `-p` /
 * `--print`) — see #1124 for the trap the old `--print` path fell into.
 *
 * Streaming mode is preserved at the public API level (callers in composer.ts
 * still `for await` the token stream) but the REPL one-shot doesn't expose a
 * mid-turn token stream the way the API does; we resolve the full text and
 * yield it once. Callers don't care: they accumulate into `fullText` anyway
 * before doing citation post-processing.
 */
async function callSonnetCli(
  opts: SonnetMessages & { stream?: boolean },
  claudeBin: string,
): Promise<{ text: string; tier: SonnetTier } | { tokens: AsyncIterable<string>; tier: SonnetTier }> {
  const prompt = buildCliPrompt(opts.system, opts.messages);
  const timeoutMs = opts.timeoutMs ?? 300_000;

  const text = await askClaudeOneShot(prompt, {
    binary: claudeBin,
    model: 'claude-sonnet-4-6',
    timeoutMs,
  });

  if (opts.stream) {
    const tokens = (async function* (): AsyncIterable<string> {
      if (text) yield text;
    })();
    return { tokens, tier: 'cli' };
  }
  return { text, tier: 'cli' };
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
