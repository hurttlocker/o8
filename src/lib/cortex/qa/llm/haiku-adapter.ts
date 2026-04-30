/**
 * Haiku CLI adapter for the Cortex Q&A layer (epic #915 path-to-70 phase 1.6).
 *
 * Single-purpose, non-streaming wrapper around `claude --print --model
 * claude-haiku-4-5-20251001`. Used as the second-tier fallback on hot paths
 * that previously degraded straight from Gemini Flash → heuristic:
 *
 *   composeClassA():  Flash → Haiku CLI → Sonnet CLI → heuristic
 *   classifyQuestion: Flash → Haiku CLI → heuristic
 *
 * Why CLI specifically:
 *   - Uses the founder's Claude Max subscription. Zero per-token cost.
 *   - No ANTHROPIC_API_KEY required. No OpenRouter required.
 *   - Mirrors src/lib/cortex/qa/llm/sonnet-adapter.ts's CLI tier exactly,
 *     so binary detection survives Finder-launched Tauri apps via login-shell.
 *
 * Why a separate adapter (vs. extending sonnet-adapter):
 *   - Callers want a dead-simple `callHaiku(prompt) → string` shape with a
 *     short timeout (8s default). Haiku is fast; long timeouts mean the
 *     CLI is wedged and we should fall through.
 *   - The Sonnet adapter has a 3-tier (CLI/API/Flash) cascade plus
 *     streaming. Haiku here is CLI-only and non-streaming on purpose.
 */

import 'server-only';

import { execFile, spawn } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ── Shared binary detection ──────────────────────────────────────────────────

let cachedClaudeBin: string | null | undefined;

/**
 * Resolve the `claude` binary the same way sonnet-adapter does:
 * env override → which → login-shell probe (zsh -lic 'command -v claude').
 *
 * Result is cached per-process. `undefined` = not yet probed,
 * `null` = probed and not found.
 */
async function resolveClaudeBin(): Promise<string | null> {
  if (cachedClaudeBin !== undefined) return cachedClaudeBin;

  // 1. Explicit env override (same keys as the runtime adapter + Sonnet adapter).
  for (const envKey of ['O8_CLAUDE_CODE_BIN', 'CLAUDE_BIN']) {
    const val = process.env[envKey];
    if (val) {
      cachedClaudeBin = val;
      return cachedClaudeBin;
    }
  }

  // 2. which claude
  try {
    const { stdout } = await execFileAsync('which', ['claude'], { timeout: 3_000 });
    const found = stdout.trim();
    if (found) {
      cachedClaudeBin = found;
      return cachedClaudeBin;
    }
  } catch {
    // not on PATH — try login shell
  }

  // 3. Login-shell probe (catches nvm/fnm/volta binaries — same as Sonnet adapter).
  const userShell = process.env.SHELL ?? 'zsh';
  for (const sh of [userShell, 'zsh', 'bash', 'sh']) {
    try {
      const { stdout } = await execFileAsync(sh, ['-l', '-c', 'command -v claude'], {
        timeout: 10_000,
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      });
      const found = stdout.trim();
      if (found) {
        cachedClaudeBin = found;
        return cachedClaudeBin;
      }
    } catch {
      // shell not available or command failed
    }
  }

  cachedClaudeBin = null;
  return null;
}

/** Force re-detection on next call (useful for testing). */
export function resetHaikuProviderCache(): void {
  cachedClaudeBin = undefined;
}

// ── stream-json parser (result event only — non-streaming) ───────────────────

/**
 * Scan Claude CLI stream-json output for the terminal `result` event and
 * return its text. Mirrors extractCliFullText in sonnet-adapter.ts so any
 * future shape change in one adapter is easy to mirror in the other.
 */
function extractResultText(output: string): string {
  const lines = output.split('\n').filter(Boolean);
  // Prefer the terminal `result` event (complete answer, no double-counting).
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const evt = JSON.parse(line) as Record<string, unknown>;
      if (evt['type'] === 'result' && typeof evt['result'] === 'string') {
        return evt['result'];
      }
    } catch {
      // not JSON — skip
    }
  }
  // Fallback: stitch assistant events if no terminal result was emitted.
  const parts: string[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const evt = JSON.parse(line) as Record<string, unknown>;
      if (evt['type'] === 'assistant' && typeof evt['message'] === 'object' && evt['message'] !== null) {
        const msg = evt['message'] as Record<string, unknown>;
        const content = msg['content'];
        if (Array.isArray(content)) {
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
        }
      }
    } catch {
      // not JSON — skip
    }
  }
  return parts.join('');
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface CallHaikuOptions {
  /** CLI invocation timeout. Default 8s — Haiku is fast; long waits mean wedged. */
  timeoutMs?: number;
}

/**
 * Call Claude Haiku via the CLI with `prompt` on stdin.
 *
 * Throws on:
 *   - claude binary not found
 *   - CLI exit code non-zero with empty stdout
 *   - timeout exceeded
 *   - empty result text
 *
 * Caller is responsible for the fallback chain (composer/classifier each
 * have their own next-step on failure — Sonnet CLI or heuristic).
 */
export async function callHaiku(prompt: string, opts: CallHaikuOptions = {}): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 8_000;

  const claudeBin = await resolveClaudeBin();
  if (!claudeBin) {
    throw new Error('[qa][haiku] claude CLI not found on PATH or login shell');
  }

  // --verbose required when combining --print + --output-format stream-json.
  // Prompt fed via stdin so multi-line content isn't mangled by argv parsing.
  const cliArgs = [
    '--print',
    '--verbose',
    '--dangerously-skip-permissions',
    '--output-format', 'stream-json',
    '--model', 'claude-haiku-4-5-20251001',
  ];

  // tmpdir cwd so no project .claude/ config bleeds in.
  const cwd = os.tmpdir();
  const env = { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' };

  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(claudeBin, cliArgs, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    child.stdin!.write(prompt, 'utf-8');
    child.stdin!.end();

    let outBuf = '';
    let errBuf = '';
    child.stdout!.on('data', (chunk: Buffer) => { outBuf += chunk.toString(); });
    child.stderr!.on('data', (chunk: Buffer) => { errBuf += chunk.toString(); });

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`[qa][haiku] CLI timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`[qa][haiku] CLI spawn error: ${err.message}`));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && outBuf.trim() === '') {
        reject(new Error(`[qa][haiku] CLI exited ${code}: ${errBuf.slice(0, 400)}`));
      } else {
        resolve(outBuf);
      }
    });
  });

  const text = extractResultText(stdout).trim();
  if (!text) {
    throw new Error('[qa][haiku] CLI returned empty result');
  }
  return text;
}
