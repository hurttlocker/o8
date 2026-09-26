import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';

const THREAD_ID = /^thoughts-[A-Za-z0-9_-]{1,80}$/;

function capabilityKey(): Buffer {
  const dataDir = getDataDir();
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, 'fast-delegation.key');
  try {
    writeFileSync(path, randomBytes(32), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const key = readFileSync(path);
  if (key.length !== 32) throw new Error('Fast delegation key is invalid');
  return key;
}

/** Minted only into the orchestrator's private MCP config, never from tool arguments. */
export function fastDelegationCapability(repoPath: string, threadId: string): string {
  if (!THREAD_ID.test(threadId)) throw new Error('Invalid Fast delegation chat');
  const canonicalRepo = realpathSync(repoPath);
  return createHmac('sha256', capabilityKey())
    .update(JSON.stringify([canonicalRepo, threadId]))
    .digest('hex');
}

export function authorizeFastDelegation(input: {
  repoPath: string;
  parentThreadId: string;
  capability: string;
}): { ok: true } | { ok: false; error: string; status: number } {
  if (!THREAD_ID.test(input.parentThreadId)) {
    return { ok: false, error: 'Fast mode requires a durable parent orchestrator chat.', status: 400 };
  }
  try {
    const historyPath = join(getDataDir(), 'chat-history', `${input.parentThreadId}.json`);
    const thread = JSON.parse(readFileSync(historyPath, 'utf8')) as {
      repoPath?: string;
      messages?: Array<{ role?: string; receipt?: { pickedMode?: string } }>;
    };
    if (!thread.repoPath || realpathSync(thread.repoPath) !== realpathSync(input.repoPath)) {
      return { ok: false, error: 'Fast mode chat and checkout must match.', status: 403 };
    }
    const messages = Array.isArray(thread.messages) ? thread.messages : [];
    const lastUser = messages.findLastIndex((message) => message.role === 'user');
    const selectedTurn = messages.slice(lastUser + 1).findLast((message) => message.role === 'assistant');
    if (lastUser < 0 || selectedTurn?.receipt?.pickedMode !== 'fast') {
      return { ok: false, error: 'The current chat turn did not select Fast mode.', status: 403 };
    }
    const expected = Buffer.from(fastDelegationCapability(input.repoPath, input.parentThreadId), 'hex');
    const received = /^[a-f0-9]{64}$/i.test(input.capability) ? Buffer.from(input.capability, 'hex') : Buffer.alloc(0);
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      return { ok: false, error: 'Fast delegation capability is invalid.', status: 403 };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: 'Fast mode parent chat is unavailable.', status: 404 };
  }
}
