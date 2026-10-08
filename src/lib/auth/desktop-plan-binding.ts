import 'server-only';

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import { readSignInEpoch } from '@/lib/github-broker/managed';
import { readAuthSignedOutAt } from '@/lib/auth/sign-out-marker';
import { ChatGPTPlanError } from '@/lib/chatgpt-plan/types';

interface Binding { owner: string; sessionId: string; sourceEpoch: string | null; generation: string }
const bindingPath = () => join(getDataDir(), 'chatgpt-desktop-account.json');

export function readDesktopPlanBinding(): Binding | null {
  try { return JSON.parse(readFileSync(bindingPath(), 'utf8')) as Binding; } catch { return null; }
}

/** Called only after first-party operator and cryptographic session validation. */
export function bindVerifiedDesktopSession(owner: string, sessionId: string, sourceEpoch: string | null, expectedGeneration: string | null): void {
  if (readSignInEpoch() !== sourceEpoch || readAuthSignedOutAt() !== null) throw new ChatGPTPlanError('o8_session_changed', 'The o8 session changed while connecting. Try again.', 409);
  const previous = readDesktopPlanBinding();
  const directory = getDataDir(); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, 'chatgpt-desktop-account.lock');
  try { mkdirSync(lock, { mode: 0o700 }); } catch { throw new ChatGPTPlanError('o8_session_busy', 'The desktop account is being updated. Try again.', 409); }
  try {
    const current = readDesktopPlanBinding();
    if ((current?.generation ?? null) !== expectedGeneration || readSignInEpoch() !== sourceEpoch || readAuthSignedOutAt() !== null) throw new ChatGPTPlanError('o8_session_changed', 'The desktop account changed while connecting. Try again.', 409);
    if (previous?.owner === owner && previous.sessionId === sessionId && previous.sourceEpoch === sourceEpoch) return;
    const temporary = join(directory, `chatgpt-account-${randomUUID()}.tmp`);
    writeFileSync(temporary, JSON.stringify({ owner, sessionId, sourceEpoch, generation: randomUUID() } satisfies Binding), { mode: 0o600 });
    renameSync(temporary, bindingPath());
  } finally { rmdirSync(lock); }
}

export function readDesktopAccountEpoch(owner: string): string {
  const binding = readDesktopPlanBinding();
  if (!binding || binding.owner !== owner || binding.sourceEpoch !== readSignInEpoch() || readAuthSignedOutAt() !== null) throw new ChatGPTPlanError('o8_session_changed', 'The selected o8 account changed. Reopen the connection in the signed-in desktop.', 409);
  return binding.generation;
}
