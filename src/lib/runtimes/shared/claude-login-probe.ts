import 'server-only';

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { hasLiveClaudeOAuth } from '@/lib/claude-code/oauth-credential';
import { cliInvocation } from '@/lib/runtimes/shared/cli-spawn';

const execFileAsync = promisify(execFile);

/** Covers a cold Claude Code CLI start in a Finder-launched app process. */
export const CLAUDE_PROBE_TIMEOUT_MS = 5_000;

/**
 * Three-state answer to "is this Claude Code CLI signed in?".
 *
 * `unknown` is load-bearing: a timeout, a non-zero exit, a spawn failure, or output
 * that is not the documented `{ "loggedIn": boolean }` shape tells us nothing about
 * the operator's session. Callers may combine it with independent positive credential
 * evidence, but must not treat the inconclusive probe itself as authentication.
 */
export type ClaudeLoginState = 'logged_in' | 'logged_out' | 'unknown';

function probeTimedOut(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as { code?: unknown; killed?: unknown };
  return record.killed === true || record.code === 'ETIMEDOUT';
}

/**
 * Runs `claude auth status --json` under a bounded timeout and buffer.
 *
 * The CLI's stdout is parsed and discarded here — it is never returned, logged, or
 * embedded in a status detail, because an unexpected build could print credential
 * material on that channel.
 */
export async function probeClaudeLoginState(
  binaryPath: string,
  timeoutMs = CLAUDE_PROBE_TIMEOUT_MS,
): Promise<ClaudeLoginState> {
  let stdout = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const probe = cliInvocation(binaryPath, ['auth', 'status', '--json']);
      ({ stdout } = await execFileAsync(probe.command, probe.args, {
        windowsHide: true,
        timeout: Math.max(1, Math.min(timeoutMs, CLAUDE_PROBE_TIMEOUT_MS)),
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
        maxBuffer: 64 * 1024,
      }));
      break;
    } catch (error) {
      if (attempt === 0 && probeTimedOut(error)) continue;
      // Timeout, killed process, non-zero exit, missing/unexecutable binary.
      return 'unknown';
    }
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

/**
 * Non-empty credential in the environment. Re-exported from the shared credential
 * module so the readiness path and the worker launch seam cannot drift apart on
 * what counts as a native credential.
 */
export { hasClaudeEnvCredential } from '@/lib/claude-code/oauth-credential';

/**
 * File-based native login evidence for the operator's own account.
 *
 * Deliberately does not read the macOS Keychain: `security find-generic-password`
 * can raise an ACL prompt, and readiness is polled. A live token in the config dir
 * or the account email Claude writes to ~/.claude.json is sufficient evidence.
 * The Keychain remains the seeding path's concern (seedNativeWorkerCredentials).
 */
export async function hasStoredClaudeOAuthCredential(): Promise<boolean> {
  const configDir = process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), '.claude');
  const [credentialRaw, userConfigRaw] = await Promise.all([
    readFile(path.join(configDir, '.credentials.json'), 'utf-8').catch(() => ''),
    readFile(path.join(os.homedir(), '.claude.json'), 'utf-8').catch(() => ''),
  ]);
  if (hasLiveClaudeOAuth(credentialRaw)) return true;
  try {
    const parsed = JSON.parse(userConfigRaw) as { oauthAccount?: unknown };
    const account = parsed?.oauthAccount;
    if (!account || typeof account !== 'object' || Array.isArray(account)) return false;
    const emailAddress = (account as Record<string, unknown>).emailAddress;
    return typeof emailAddress === 'string' && emailAddress.trim().length > 0;
  } catch {
    return false;
  }
}
