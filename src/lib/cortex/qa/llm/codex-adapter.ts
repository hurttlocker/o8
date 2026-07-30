/**
 * Codex CLI adapter for the Cortex Q&A layer (epic #915 path-to-70 phase 1.7 v2).
 *
 * Single-purpose, non-streaming wrapper around `codex exec --skip-git-repo-check
 * --output-last-message <tmpfile> -m <model>`. Sits as the second free-tier
 * fallback in the Class A chain, after Haiku CLI:
 *
 *   composeClassA():  Haiku CLI → Codex CLI → OpenRouter → Flash → Sonnet → heuristic
 *   classifyQuestion: Haiku CLI → Codex CLI → OpenRouter → Flash → heuristic
 *
 * Why a CLI tier (not API):
 *   - The founder has the ChatGPT Plus / Codex subscription, so the CLI is
 *     free (uses the sub's quota). Two free paths beat one for users with
 *     either Claude Max or ChatGPT Plus — most have one or the other.
 *   - No OPENAI_API_KEY needed, no billing leak.
 *
 * Why a separate adapter (vs. extending haiku-adapter):
 *   - Different binary (`codex` vs `claude`), different output mechanism
 *     (Codex writes the final message to a tmpfile; Claude streams JSON to
 *     stdout). Mixing them would muddle the parser.
 *   - Codex bootstrap + reasoning is ~15-16s for trivial prompts (verified
 *     live with gpt-5.4). The default 30s timeout reflects this.
 */

import 'server-only';

import { execFile, spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { resolveDefaultDispatchModelSync } from '@/lib/operator/defaults';
import { codexModelArgs, parseLocalModel } from '@/lib/codex/local-model';
import { MODEL_IDS } from '@/lib/models';

const execFileAsync = promisify(execFile);

// ── Shared binary detection ──────────────────────────────────────────────────

let cachedCodexBin: string | null | undefined;

/**
 * Resolve the `codex` binary the same way haiku-adapter resolves `claude`:
 * env override → which → login-shell probe (zsh -lic 'command -v codex').
 *
 * Result is cached per-process. `undefined` = not yet probed,
 * `null` = probed and not found.
 */
async function resolveCodexBin(): Promise<string | null> {
  if (cachedCodexBin !== undefined) return cachedCodexBin;

  // 1. Explicit env override (matches the runtime adapter convention).
  for (const envKey of ['O8_CODEX_BIN', 'CODEX_BIN']) {
    const val = process.env[envKey];
    if (val) {
      cachedCodexBin = val;
      return cachedCodexBin;
    }
  }

  // 2. which codex
  try {
    const { stdout } = await execFileAsync('which', ['codex'], { timeout: 3_000 });
    const found = stdout.trim();
    if (found) {
      cachedCodexBin = found;
      return cachedCodexBin;
    }
  } catch {
    // not on PATH — try login shell
  }

  // 3. Login-shell probe (catches nvm/fnm/volta binaries — same as Sonnet/Haiku).
  const userShell = process.env.SHELL ?? 'zsh';
  for (const sh of [userShell, 'zsh', 'bash', 'sh']) {
    try {
      const { stdout } = await execFileAsync(sh, ['-l', '-c', 'command -v codex'], {
        timeout: 10_000,
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      });
      const found = stdout.trim();
      if (found) {
        cachedCodexBin = found;
        return cachedCodexBin;
      }
    } catch {
      // shell not available or command failed
    }
  }

  cachedCodexBin = null;
  return null;
}

/** Force re-detection on next call (useful for testing). */
export function resetCodexProviderCache(): void {
  cachedCodexBin = undefined;
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface CallCodexOptions {
  /** Model to pass to `codex exec -m`. Default: gpt-5.5 (post-SDK-pricing pivot, epic #1044). */
  model?: string;
  /** Explicit resolved binary, used when the caller already ran auth detection. */
  binary?: string;
  /** Optional Codex config effort passed as `-c model_reasoning_effort=...`. */
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
  /** CLI invocation timeout. Default 30s — Codex bootstrap is ~15s. */
  timeoutMs?: number;
}

/** Default Codex model. gpt-5.5 replaces gpt-5.4 as the orchestrator-class default (epic #1044). */
export const CODEX_DEFAULT_MODEL = MODEL_IDS.codexDefault;

/**
 * Resolve the Codex model for a Q&A call. An explicit model wins. Otherwise, if
 * the operator's default dispatch model is LOCAL (`ollama:`/`lmstudio:`), the
 * Brain composes on that local model too — so a zero-cloud-key dev gets real
 * synthesized answers (not just retrieved sources) with no Codex subscription.
 * A cloud dispatch model does NOT change the default here (gpt-5.5 stays).
 */
function resolveCodexQaModel(explicit?: string): string {
  if (explicit) return explicit;
  try {
    const dispatch = resolveDefaultDispatchModelSync().trim();
    if (dispatch && parseLocalModel(dispatch)) return dispatch;
  } catch {
    // operator defaults unavailable — fall through to the cloud default
  }
  return CODEX_DEFAULT_MODEL;
}

export function buildCodexQaArgs(options: {
  model: string;
  outputFile: string;
  reasoningEffort?: CallCodexOptions['reasoningEffort'];
}): string[] {
  return [
    'exec',
    '--skip-git-repo-check',
    '--output-last-message', options.outputFile,
    // Local models expand to `--oss --local-provider … --model`; cloud models to
    // `--model <name>` (equivalent to the historical `-m`).
    ...codexModelArgs(options.model),
    ...(options.reasoningEffort
      ? ['-c', `model_reasoning_effort=${options.reasoningEffort}`]
      : []),
  ];
}

/**
 * Call Codex via the CLI with `prompt` on stdin and read the final answer
 * from a tmpfile written by `--output-last-message`.
 *
 * Throws on:
 *   - codex binary not found
 *   - CLI exit code non-zero
 *   - timeout exceeded
 *   - empty result tmpfile
 *
 * Caller is responsible for the fallback chain (composer/classifier each
 * have their own next-step on failure — OpenRouter → Flash → Sonnet → heuristic).
 */
export async function callCodex(prompt: string, opts: CallCodexOptions = {}): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const model = resolveCodexQaModel(opts.model);

  const codexBin = opts.binary ?? await resolveCodexBin();
  if (!codexBin) {
    throw new Error('[qa][codex] codex CLI not found on PATH or login shell');
  }

  // Tmpfile for `--output-last-message`. Use a unique name per invocation so
  // concurrent calls don't clobber each other.
  const tmpFile = path.join(
    os.tmpdir(),
    `o8-codex-qa-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`,
  );

  const cliArgs = buildCodexQaArgs({
    model,
    outputFile: tmpFile,
    reasoningEffort: opts.reasoningEffort,
  });

  // tmpdir cwd so no project .codex/ config bleeds in.
  const cwd = os.tmpdir();
  const env = { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' };

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(codexBin, cliArgs, {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      child.stdin!.write(prompt, 'utf-8');
      child.stdin!.end();

      // Drain stdout/stderr so the OS pipe buffer doesn't fill and stall the
      // child. We don't actually read from these — the answer is in tmpFile.
      let errBuf = '';
      child.stdout!.on('data', () => { /* drain */ });
      child.stderr!.on('data', (chunk: Buffer) => { errBuf += chunk.toString(); });

      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`[qa][codex] CLI timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`[qa][codex] CLI spawn error: ${err.message}`));
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`[qa][codex] CLI exited ${code}: ${errBuf.slice(0, 400)}`));
        } else {
          resolve();
        }
      });
    });

    // Read the answer from the tmpfile.
    let text = '';
    try {
      text = (await fsp.readFile(tmpFile, 'utf-8')).trim();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`[qa][codex] failed to read result tmpfile: ${message}`);
    }

    if (!text) {
      throw new Error('[qa][codex] CLI produced empty result tmpfile');
    }
    return text;
  } finally {
    // Best-effort cleanup; don't mask the original error if unlink fails.
    fsp.unlink(tmpFile).catch(() => undefined);
  }
}
