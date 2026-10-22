import { resolveProviderKey } from '@/lib/providers/key-store';
import 'server-only';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { cliInvocation } from './cli-spawn';
import { connectionEvidence } from './connection-evidence';

const execFileAsync = promisify(execFile);

export async function codexAuthEvidence(binaryPath: string) {
  let authJson: Record<string, unknown> | null = null;
  try {
    const value: unknown = JSON.parse(await readFile(path.join(os.homedir(), '.codex', 'auth.json'), 'utf-8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) authJson = value as Record<string, unknown>;
  } catch { /* No readable credential evidence. */ }
  const envCredential = Boolean(resolveProviderKey('OPENAI_API_KEY') || process.env.CODEX_ACCESS_TOKEN);
  const fileCredential = Boolean(authJson?.tokens && typeof authJson.tokens === 'object');
  let login: 'present' | 'absent' | 'unknown' = 'unknown';
  try {
    const probe = cliInvocation(binaryPath, ['login', 'status']);
    const { stdout, stderr } = await execFileAsync(probe.command, probe.args, {
      windowsHide: true, timeout: 1500, maxBuffer: 64 * 1024,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    });
    const output = `${stdout}\n${stderr}`.toLowerCase();
    if (output.includes('not logged in') || output.includes('logged out')) login = 'absent';
    else if (output.includes('logged in')) login = 'present';
  } catch (error) {
    // Codex reports a normal signed-out result on stderr with exit code 1.
    // Transport errors and unrecognized failure output still prove nothing.
    const failure = error as { code?: unknown; killed?: boolean; signal?: unknown; stderr?: unknown };
    if (failure?.code === 1 && !failure.killed && !failure.signal
      && typeof failure.stderr === 'string' && /^\s*Not logged in\s*$/i.test(failure.stderr)) login = 'absent';
  }
  const authenticated = login === 'present' || envCredential || fileCredential;
  return {
    authenticated,
    connection: connectionEvidence(authenticated ? ['OpenAI'] : [], [
      { source: 'cli_report', outcome: login },
      { source: 'environment', outcome: envCredential ? 'present' : 'absent' },
      { source: 'credential_file', outcome: fileCredential ? 'present' : 'absent' },
    ]),
  };
}
