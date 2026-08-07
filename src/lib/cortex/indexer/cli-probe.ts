/**
 * CLI probe for the Engineering Brain Indexer (#915 north star #2).
 *
 * The worker distills facts from raw substrate via a CLI call. Two providers
 * are supported:
 *   - claude (default, Sonnet quality > Codex on extraction per round-3 lock)
 *   - codex  (override via O8_INDEXER_CLI=codex; uses gpt-5.5)
 *
 * If neither binary is on PATH (or login-shell PATH), the worker disables
 * itself gracefully — free-tier users keep raw retrieval. We do NOT fall
 * back to OpenRouter / Anthropic API for the indexer (founder constraint).
 *
 * Probing is cached module-level so the worker only pays the syscall cost
 * once per process.
 */

import 'server-only';

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveBrainUseClaudeCliSync } from '@/lib/operator/defaults';
import { cliInvocation } from '@/lib/runtimes/shared/cli-spawn';

const execFileAsync = promisify(execFile);

export type IndexerCli = 'claude' | 'codex';

let cachedCli: IndexerCli | null | undefined;

/**
 * Resolve a CLI binary via the same chain used by the QA adapters:
 *   1. env override (O8_*_BIN / *_BIN)
 *   2. `which <name>`
 *   3. login-shell `command -v <name>`
 *
 * Returns the resolved binary path, or null if not found.
 */
async function resolveBin(
  name: 'claude' | 'codex',
  envKeys: string[],
): Promise<string | null> {
  // 1. env override
  for (const key of envKeys) {
    const val = process.env[key];
    if (val) return val;
  }

  // 2. which
  try {
    const { stdout } = await execFileAsync('which', [name], { windowsHide: true, timeout: 3_000 });
    const found = stdout.trim();
    if (found) return found;
  } catch {
    // not on PATH — try login shell
  }

  // 3. login-shell probe (catches nvm/fnm/volta binaries)
  const userShell = process.env.SHELL ?? 'zsh';
  for (const sh of [userShell, 'zsh', 'bash', 'sh']) {
    try {
      const { stdout } = await execFileAsync(sh, ['-l', '-c', `command -v ${name}`], {
        windowsHide: true,
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

/** Verify the binary actually executes — `claude --version` / `codex --version`. */
async function verifyBin(bin: string): Promise<boolean> {
  try {
    const probe = cliInvocation(bin, ['--version']);
    await execFileAsync(probe.command, probe.args, {
      windowsHide: true,
      timeout: 5_000,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect which indexer CLI is available, honoring O8_INDEXER_CLI override.
 * Returns 'claude' | 'codex' | null. Cached after first call.
 *
 * Preference order when no override is set and the Brain may use the Claude
 * CLI (`brainUseClaudeCli`): claude first (Sonnet extraction quality > Codex on
 * this task per round-3 lock), then codex. When it's off, skip claude entirely
 * because the downstream Sonnet adapter is gate-protected by the same setting
 * (decoupled from the orchestrator toggle 2026-06-22).
 */
export async function probeIndexerCli(): Promise<IndexerCli | null> {
  const brainCliEnabled = resolveBrainUseClaudeCliSync();
  if (cachedCli !== undefined) {
    if (brainCliEnabled || cachedCli !== 'claude') return cachedCli;
    cachedCli = undefined;
  }

  if (!brainCliEnabled) {
    const codexBin = await resolveBin('codex', ['O8_CODEX_BIN', 'CODEX_BIN']);
    if (codexBin && await verifyBin(codexBin)) {
      cachedCli = 'codex';
      console.log(`[indexer] CLI: codex (${codexBin})`);
      return cachedCli;
    }

    console.warn(
      '[indexer] disabled — brainUseClaudeCli is off and Codex CLI is unavailable.',
    );
    cachedCli = null;
    return cachedCli;
  }

  const override = process.env.O8_INDEXER_CLI?.trim();
  if (override === 'claude' || override === 'codex') {
    const bin = await resolveBin(override, override === 'claude'
      ? ['O8_CLAUDE_CODE_BIN', 'CLAUDE_BIN']
      : ['O8_CODEX_BIN', 'CODEX_BIN']);
    if (bin && await verifyBin(bin)) {
      cachedCli = override;
      console.log(`[indexer] CLI override O8_INDEXER_CLI=${override} verified (${bin})`);
      return cachedCli;
    }
    console.warn(
      `[indexer] CLI override O8_INDEXER_CLI=${override} but binary not found / failed --version. ` +
        'Worker disabled.',
    );
    cachedCli = null;
    return cachedCli;
  }

  // Default order: claude → codex.
  const claudeBin = await resolveBin('claude', ['O8_CLAUDE_CODE_BIN', 'CLAUDE_BIN']);
  if (claudeBin && await verifyBin(claudeBin)) {
    cachedCli = 'claude';
    console.log(`[indexer] CLI: claude (${claudeBin})`);
    return cachedCli;
  }

  const codexBin = await resolveBin('codex', ['O8_CODEX_BIN', 'CODEX_BIN']);
  if (codexBin && await verifyBin(codexBin)) {
    cachedCli = 'codex';
    console.log(`[indexer] CLI: codex (${codexBin})`);
    return cachedCli;
  }

  console.warn(
    '[indexer] disabled — install Claude Max or ChatGPT Plus + Codex CLI to enable.',
  );
  cachedCli = null;
  return cachedCli;
}

/** Force re-probe on next call (testing / DI). */
export function resetIndexerCliCache(): void {
  cachedCli = undefined;
}
