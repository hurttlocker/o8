/**
 * One-shot `claude --input-format stream-json` REPL helper (#1124).
 *
 * Spawns an ephemeral `claude` process with the exact same flags as the
 * interactive chat tab (no `-p` / `--print`) so the call bills against the
 * user's Claude Code MAX subscription pool — NOT the gated Agent SDK pool
 * that `claude --print` taps. This is the brain Q&A equivalent of the chat
 * tab's REPL spawn (`interactive-session.ts`).
 *
 * Surface:
 *   askClaudeOneShot(prompt, { binary, model, cwd, timeoutMs }) → string
 *
 * The helper opens a fresh process, writes one `{ type: 'user', message: ... }`
 * frame to stdin, consumes stream-json events until a `result` event arrives,
 * and resolves the full assistant text. Process is torn down after the turn —
 * no idle timer, no session registry, no abort plumbing. Callers (brain
 * adapters) want a dead-simple `prompt → text` shape.
 *
 * Why not reuse `interactive-session.ts` directly: that module is built around
 * long-lived tabbed sessions (tabIds, idle timers, mode-change re-spawn, resume
 * IDs, abort signals, parser plan/tool/permission emissions). Brain Q&A wants
 * none of it; forcing it through would add coupling and pull surface we don't
 * need. The spawn flags + stream-json contract are the only shared shape, and
 * those live here so both call sites stay one-line obvious.
 */

import 'server-only';
import { resolveClaudeBinary } from '@/lib/runtimes/shared/cli-locate';

import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import os from 'node:os';

import {
  createClaudeCodeStreamJsonParser,
} from './stream-json-parser';
import { assertNoPrintFlag } from './assert-no-print-flag';
import { claudeEffortFlagValue } from '@/lib/orchestrator/thinking-effort';
import { cliInvocation } from '@/lib/runtimes/shared/cli-spawn';

export interface AskClaudeOneShotOptions {
  /** Explicit `claude` binary path. Caller resolves; we don't probe. */
  binary: string;
  /** Model arg passed via `--model` (e.g. `claude-sonnet-5`). */
  model: string;
  /** Optional reasoning effort passed via `--effort` (skipped when unset or 'adaptive'). */
  effort?: string;
  /** Optional cwd. Defaults to os.tmpdir() so no project .claude/ config bleeds in. */
  cwd?: string;
  /** Process timeout. Default 300_000 (5min) — matches the prior CLI ceiling. */
  timeoutMs?: number;
}

/**
 * Build the exact REPL spawn args used by `interactive-session.ts`. Stays in
 * lockstep with `buildClaudeArgs()` there — if that ever changes, mirror here.
 * NO `-p` / `--print` (those flip billing to the SDK pool).
 *
 * Exported for `warm-repl-pool.ts` so the pre-warmed spawn path shares the
 * exact same flag set (and the same #1066 no-print billing guard).
 */
export function buildOneShotArgs(model: string, effort?: string): string[] {
  const args = [
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'bypassPermissions',
    '--include-partial-messages',
    '--model', model,
  ];
  // Mirror the orchestrator precedent (orchestrator-session.ts) — attach an
  // explicit reasoning effort only when the caller asks for a non-adaptive one.
  if (effort && effort !== 'adaptive') args.push('--effort', claudeEffortFlagValue(effort));
  // #1066 billing guard — enforce what line 52's comment only described.
  assertNoPrintFlag(args, 'One-shot Claude REPL');
  return args;
}

/**
 * One-shot turn against the REPL. Spawns, sends one user message, reads
 * stream-json until `result`, resolves with the assistant text. Rejects on
 * exit-without-result, timeout, or spawn error.
 */
export async function askClaudeOneShot(
  prompt: string,
  opts: AskClaudeOneShotOptions,
): Promise<string> {
  const cwd = opts.cwd ?? os.tmpdir();
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const env = { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', O8_MANAGED_SESSION: '1' };

  return new Promise<string>((resolve, reject) => {
    const launch = cliInvocation(opts.binary, buildOneShotArgs(opts.model, opts.effort));
    const child = spawn(launch.command, launch.args, {
      windowsHide: true,
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const parser = createClaudeCodeStreamJsonParser();
    let resultText = '';
    let stderrBuf = '';
    let settled = false;

    const finish = (err: Error | null, text?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* already dead */ }
      if (err) reject(err);
      else resolve(text ?? '');
    };

    const timer = setTimeout(() => {
      finish(new Error(`[qa][claude-repl] timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      const events = parser.pushChunk(chunk.toString('utf8'));
      for (const evt of events) {
        if (evt.type === 'done') {
          resultText = evt.text ?? resultText;
          finish(null, resultText.trim());
          return;
        }
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8');
      if (stderrBuf.length > 4_000) stderrBuf = stderrBuf.slice(-4_000);
    });

    child.on('error', (err) => {
      finish(new Error(`[qa][claude-repl] spawn error: ${err.message}`));
    });

    child.on('close', (code, signal) => {
      // Flush any trailing buffered line — `done` may arrive without trailing newline.
      const trailing = parser.flush();
      for (const evt of trailing) {
        if (evt.type === 'done') {
          resultText = evt.text ?? resultText;
          finish(null, resultText.trim());
          return;
        }
      }
      if (settled) return;
      const suffix = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
      finish(new Error(
        `[qa][claude-repl] exited before result (${suffix})${stderrBuf.trim() ? `: ${stderrBuf.trim().slice(0, 400)}` : ''}`,
      ));
    });

    // Send the one-shot user message in the REPL frame shape.
    const payload = `${JSON.stringify({
      type: 'user',
      message: { role: 'user', content: prompt },
    })}\n`;

    try {
      child.stdin.write(payload, 'utf8', (writeErr?: Error | null) => {
        if (writeErr) finish(writeErr);
        else child.stdin.end();
      });
    } catch (err) {
      finish(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/**
 * Default `claude` binary resolution mirroring `interactive-session.ts`.
 * Callers that already cache a binary path can pass it directly to
 * `askClaudeOneShot`; this is just the fallback default.
 */
export function defaultClaudeBin(): string {
  // Shared validated resolver (F6JHXW) — see cli-locate.resolveClaudeBinary.
  return resolveClaudeBinary();
}
