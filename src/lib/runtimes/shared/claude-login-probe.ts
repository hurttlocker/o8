import 'server-only';

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { hasLiveClaudeOAuth } from '@/lib/claude-code/oauth-credential';
import { cliInvocation } from '@/lib/runtimes/shared/cli-spawn';

const execFileAsync = promisify(execFile);

/** Matches the general CLI probe budget in auth-detect.ts. */
export const CLAUDE_PROBE_TIMEOUT_MS = 1_500;

/**
 * Three-state answer to "is this Claude Code CLI signed in?".
 *
 * `unknown` is load-bearing: a timeout, a non-zero exit, a spawn failure, or output
 * that is not the documented `{ "loggedIn": boolean }` shape tells us nothing about
 * the operator's session. Collapsing those into `false` would lock a signed-in
 * operator out of dispatch, so callers must handle `unknown` separately.
 */
export type ClaudeLoginState = 'logged_in' | 'logged_out' | 'unknown';

/**
 * Runs `claude auth status --json` under a bounded timeout and buffer.
 *
 * The CLI's stdout is parsed and discarded here — it is never returned, logged, or
 * embedded in a status detail, because an unexpected build could print credential
 * material on that channel.
 */
export async function probeClaudeLoginState(binaryPath: string): Promise<ClaudeLoginState> {
  let stdout: string;
  try {
    const probe = cliInvocation(binaryPath, ['auth', 'status', '--json']);
    ({ stdout } = await execFileAsync(probe.command, probe.args, {
      windowsHide: true,
      timeout: CLAUDE_PROBE_TIMEOUT_MS,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      maxBuffer: 64 * 1024,
    }));
  } catch {
    // Timeout, killed process, non-zero exit, missing/unexecutable binary.
    return 'unknown';
  }
  try {
    const parsed = JSON.parse(stdout.trim()) as { loggedIn?: unknown };
    if (parsed?.loggedIn === true) return 'logged_in';
    if (parsed?.loggedIn === false) return 'logged_out';
    return 'unknown';
  } catch {
    // Malformed or non-JSON output (banner, update notice, prompt).
    return 'unknown';
  }
}

/** Non-empty credential in the environment. An empty string is not a credential. */
export function hasClaudeEnvCredential(): boolean {
  return Boolean(
    process.env.ANTHROPIC_API_KEY?.trim()
    || process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim(),
  );
}

/**
 * On-disk OAuth evidence for the operator's own config dir.
 *
 * Deliberately file-only: the macOS Keychain also holds this credential, but
 * `security find-generic-password` can raise an ACL prompt, and readiness is polled.
 * The Keychain remains the seeding path's concern (seedNativeWorkerCredentials).
 */
export async function hasStoredClaudeOAuthCredential(): Promise<boolean> {
  const configDir = process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), '.claude');
  const raw = await readFile(path.join(configDir, '.credentials.json'), 'utf-8').catch(() => '');
  return hasLiveClaudeOAuth(raw);
}
