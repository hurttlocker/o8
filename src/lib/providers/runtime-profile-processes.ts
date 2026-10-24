import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import { isMetadataLockProcessIdentity, probeMetadataLockProcessIdentitySync, sameMetadataLockProcessIdentity } from '@/lib/worktree/metadata-lock-process-identity';
import { canonicalProfilePath, profileContains } from './runtime-profile-paths';

const directory = () => join(getDataDir(), 'runtime-profile-processes');
const issue = '#4340 (https://github.com/hurttlocker/o8/issues/4340)';

/** Only an explicit launch receipt establishes historical API permission. */
export function assertNoRecordedApiProfileChild(profiles: readonly string[]): void {
  if (!profiles.length || !existsSync(directory())) return;
  for (const name of readdirSync(directory())) {
    if (!name.endsWith('.json')) continue;
    let record;
    try { record = JSON.parse(readFileSync(join(directory(), name), 'utf8')); } catch { continue; }
    if (record?.version !== 1 || record.owner !== 'o8' || record.apiAllowedAtLaunch !== true
      || !Number.isSafeInteger(record.pid) || record.pid <= 0 || !Array.isArray(record.profiles)
      || !isMetadataLockProcessIdentity(record.processIdentity)) continue;
    const selected = profiles.find(profile => record.profiles.some((other: unknown) => typeof other === 'string'
      && (profileContains(profile, other) || profileContains(other, profile))));
    if (!selected) continue;
    const probe = probeMetadataLockProcessIdentitySync(record.pid);
    if (probe.state === 'absent') continue;
    if (probe.state === 'live' && !sameMetadataLockProcessIdentity(probe.identity, record.processIdentity)) continue;
    throw new Error(`An o8-recorded API child is still running, or its exit cannot be verified, on profile ${JSON.stringify(selected)}. Stop that child before retrying. See ${issue}.`);
  }
}

/** Non-secret receipt, persisted immediately after creation under the credential lock. */
export function recordRuntimeProfileChild(result: unknown, runtimeId: string | undefined, profiles: readonly string[], env: Record<string, string>): void {
  if (!profiles.length || !result || typeof result !== 'object') return;
  const candidate = result as { child?: unknown; pid?: number; once?: (event: string, listener: () => void) => unknown; onExit?: (listener: () => void) => unknown; kill?: () => unknown };
  if (candidate.child) return recordRuntimeProfileChild(candidate.child, runtimeId, profiles, env);
  if (!candidate.pid || typeof candidate.once !== 'function' && typeof candidate.onExit !== 'function') return; // synchronous calls have already exited
  const probe = probeMetadataLockProcessIdentitySync(candidate.pid);
  if (probe.state !== 'live') return; // a PID without birth identity is not ownership proof
  const file = join(directory(), `${randomUUID()}.json`);
  try {
    mkdirSync(directory(), { recursive: true, mode: 0o700 });
    const policy = env.O8_CHILD_CREDENTIAL_POLICY ? JSON.parse(env.O8_CHILD_CREDENTIAL_POLICY) : {};
    writeFileSync(file, JSON.stringify({ version: 1, owner: 'o8', runtimeId: runtimeId ?? 'acp', pid: candidate.pid,
      processIdentity: probe.identity,
      profiles: profiles.map(canonicalProfilePath), apiAllowedAtLaunch: policy.apiAllowed === true }), { flag: 'wx', mode: 0o600 });
  } catch {
    candidate.kill?.();
    throw new Error('Runtime launch refused: its profile process receipt could not be saved.');
  }
  const cleanup = () => { try { unlinkSync(file); } catch { /* stale receipts are checked against process birth */ } };
  if (candidate.once) candidate.once('close', cleanup);
  else candidate.onExit!(cleanup);
}
