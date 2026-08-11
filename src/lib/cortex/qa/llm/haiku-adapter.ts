/**
 * Haiku CLI adapter for the Cortex Q&A layer (epic #915 path-to-70 phase 1.6,
 * REPL migration #1124).
 *
 * Single-purpose, non-streaming wrapper around the `claude --input-format
 * stream-json` REPL spawn (no `-p` / `--print`) targeting
 * claude-haiku-4-5-20251001. Used as a CLI tier on hot paths:
 *
 *   composeClassA():  Codex → OpenRouter → Flash → Haiku/Sonnet CLI → heuristic
 *   classifyQuestion: OpenRouter → Codex → Haiku CLI → Flash → heuristic
 *
 * Why REPL (not `--print`):
 *   - `--print` bills against the user's Agent SDK pool. The REPL spawn bills
 *     against the user's Claude Code MAX subscription pool — the same line a
 *     terminal `claude` REPL session uses. See #1124 for the trap; #1066 for
 *     the original REPL migration on the chat tab.
 *   - Shared spawn shape via src/lib/claude-code/one-shot-repl.ts so any
 *     future flag change stays in lockstep with the chat tab and Sonnet
 *     adapter.
 *
 * Why CLI specifically:
 *   - Uses the user's Claude Max subscription. Zero per-token cost.
 *   - No ANTHROPIC_API_KEY required. No OpenRouter required.
 *   - Mirrors src/lib/cortex/qa/llm/sonnet-adapter.ts's CLI tier exactly,
 *     so binary detection survives Finder-launched Tauri apps via login-shell.
 */

import 'server-only';

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { askClaudeWarm, prewarmClaudeRepl } from '@/lib/claude-code/warm-repl-pool';
import { MODEL_IDS } from '@/lib/models';
import { isRuntimeQuotaLimitError } from '@/lib/orchestrator/cross-house-policy';

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
    const { stdout } = await execFileAsync('which', ['claude'], { windowsHide: true, timeout: 3_000 });
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
        windowsHide: true,
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

// ── Public API ───────────────────────────────────────────────────────────────

export interface CallHaikuOptions {
  /** CLI invocation timeout. Default 8s — Haiku is fast; long waits mean wedged. */
  timeoutMs?: number;
}

/**
 * Call Claude Haiku via the REPL one-shot helper. Subscription-billed
 * (`claude --input-format stream-json`, no `-p` / `--print`) — see #1124 for
 * the SDK-billing trap the prior `--print` path fell into.
 *
 * Throws on:
 *   - brainUseClaudeCli setting OFF (the Brain's own Claude-CLI gate)
 *   - claude binary not found
 *   - REPL spawn / exit error
 *   - timeout exceeded
 *   - empty result text
 *
 * Caller is responsible for the fallback chain (composer/classifier each
 * have their own next-step on failure — Codex CLI, OpenRouter, Flash,
 * Sonnet CLI, heuristic).
 */
export async function callHaiku(prompt: string, opts: CallHaikuOptions = {}): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 8_000;

  // Subscription pool gate — Brain-specific (2026-06-22). Decoupled from the
  // orchestrator toggle: when `brainUseClaudeCli` is OFF the user has opted the
  // Brain out of the Claude CLI tier (no Max sub, or Codex/OpenRouter only), so
  // we throw and let the cascade fall through. Dynamic import keeps the
  // server-only dependency graph one-way.
  const { resolveBrainUseClaudeCliSync } = await import('@/lib/operator/brain-routing');
  if (!resolveBrainUseClaudeCliSync()) {
    throw new Error('[qa][haiku] disabled by operator setting (brainUseClaudeCli=false)');
  }

  const claudeBin = await resolveClaudeBin();
  if (!claudeBin) {
    throw new Error('[qa][haiku] claude CLI not found on PATH or login shell');
  }

  const text = await askClaudeWarm(prompt, {
    binary: claudeBin,
    model: HAIKU_MODEL,
    timeoutMs,
  });
  if (!text.trim()) {
    throw new Error('[qa][haiku] REPL returned empty result');
  }
  if (isRuntimeQuotaLimitError(text)) {
    throw new Error(`[qa][haiku] Claude subscription unavailable: ${text.trim()}`);
  }
  return text;
}

const HAIKU_MODEL = MODEL_IDS.claudeHaikuQaDefault;

/**
 * Fire-and-forget: pre-spawn a warm Haiku REPL so the next `callHaiku` skips
 * the 6-9s CLI bootstrap. Called at brain-pipeline start (ask.ts). No-ops
 * when brainUseClaudeCli is off (the tier would throw anyway) or the binary
 * can't be resolved.
 */
export async function prewarmHaiku(): Promise<void> {
  try {
    const { resolveBrainUseClaudeCliSync } = await import('@/lib/operator/brain-routing');
    if (!resolveBrainUseClaudeCliSync()) return;
    const claudeBin = await resolveClaudeBin();
    if (claudeBin) prewarmClaudeRepl(claudeBin, HAIKU_MODEL);
  } catch {
    // Pre-warm is best-effort — never let it surface into the pipeline.
  }
}
