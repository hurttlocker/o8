import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { resolveCli } from './cli-resolver';
import { cliInvocation } from './cli-spawn';

const execFileAsync = promisify(execFile);

/** Probe the same binary as dispatch; installation alone is not sign-in evidence. */
export async function probeAntigravityLogin(deadlineAt = Date.now() + 10_000) {
  let binaryPath: string | undefined;
  let authenticated = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (deadlineAt <= Date.now()) throw new Error('Probe deadline elapsed');
    binaryPath = (await Promise.race([resolveCli({
      runtimeId: 'antigravity', binaryName: 'agy', envOverride: 'O8_ANTIGRAVITY_BIN',
    }), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('CLI lookup timed out')), deadlineAt - Date.now());
    })])).path;
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) throw new Error('Probe deadline elapsed');
    const invocation = cliInvocation(binaryPath, ['models']);
    const { stdout } = await execFileAsync(invocation.command, invocation.args, {
      timeout: remainingMs, maxBuffer: 128 * 1024,
    });
    authenticated = /^(?:gemini-|claude-|gpt-)[\w.-]+\s+\S+/m.test(stdout);
  } catch { /* Sign-in failure or provider unavailability must not imply readiness. */ }
  finally { clearTimeout(timer); }
  return {
    installed: Boolean(binaryPath), authenticated, binaryPath,
    detail: authenticated
      ? 'CLI sign-in is available. Model access remains subject to account quota.'
      : 'CLI sign-in could not be verified.',
    fix: 'Run agy and sign in with Google. Keep Use AI Credits off for quota-only use.',
  };
}
