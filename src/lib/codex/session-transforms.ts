import 'server-only';

import os from 'node:os';
import path from 'node:path';

import {
  CodexAppServerClient,
  CodexAppServerRequestError,
} from '@/lib/codex/app-server-client';
import { getRuntimeIdentityForServer } from '@/lib/runtime/identity-catalog';
import { resolveCli } from '@/lib/runtimes/shared/cli-resolver';
import type {
  RuntimeSession,
  RuntimeSessionTransformCapabilityDetails,
  RuntimeSessionTransformInput,
  RuntimeSessionTransformProviderResult,
  RuntimeSessionTransformRecoveryInput,
} from '@/lib/runtimes/types';

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function threadIdFromSessionKey(sessionKey: string): string | null {
  if (sessionKey.startsWith('codex-discovered:')) {
    return sessionKey.slice('codex-discovered:'.length).trim() || null;
  }
  if (sessionKey.startsWith('codex:')) {
    return sessionKey.slice('codex:'.length).trim() || null;
  }
  return null;
}

function runtimeStatus(thread: JsonRecord): RuntimeSession['status'] {
  const type = stringValue(record(thread.status)?.type);
  if (type === 'active') return 'running';
  if (type === 'systemError') return 'failed';
  return 'idle';
}

function sessionFromThread(thread: JsonRecord, identityId?: string): RuntimeSession | null {
  const id = stringValue(thread.id);
  const cwd = stringValue(thread.cwd);
  if (!id || !cwd) return null;
  const gitInfo = record(thread.gitInfo);
  const updatedAtSeconds = typeof thread.updatedAt === 'number'
    ? thread.updatedAt
    : Date.now() / 1_000;
  return {
    sessionKey: `codex:${id}`,
    runtimeId: 'codex',
    displayName: stringValue(thread.name) ?? stringValue(thread.preview) ?? 'Codex session',
    cwd,
    branch: stringValue(gitInfo?.branch),
    headSha: stringValue(gitInfo?.sha),
    status: runtimeStatus(thread),
    ownership: 'provider',
    sessionCapabilities: {
      canSendInput: true,
      canInterrupt: false,
      canReviewDiffs: true,
    },
    lastActivityAt: new Date(updatedAtSeconds * 1_000),
    initialTask: stringValue(thread.preview),
    identityId,
  };
}

function unsupportedCapabilities(reason: string): RuntimeSessionTransformCapabilityDetails {
  return {
    import: { supported: false, reason },
    checkpoint: { supported: false, reason },
    fork: { supported: false, reason },
    rewind: { supported: false, reason },
  };
}

export function getCodexSessionTransformCapabilities(
  sessionKey: string,
): RuntimeSessionTransformCapabilityDetails {
  if (!threadIdFromSessionKey(sessionKey)) {
    return unsupportedCapabilities(
      'Only durable provider sessions can be transformed. Live and o8-owned process surfaces keep their existing lifecycle controls.',
    );
  }
  return {
    import: { supported: true },
    checkpoint: { supported: true },
    fork: { supported: true },
    rewind: { supported: true },
  };
}

function defaultCodexHome(): string {
  return process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex');
}

async function resolveCodexHome(identityId?: string): Promise<string> {
  if (!identityId) return defaultCodexHome();
  const identity = await getRuntimeIdentityForServer('codex', identityId);
  if (!identity) throw new Error('The Codex runtime identity is no longer registered.');
  return identity.configHomeRef;
}

async function withCodexAppServer<T>(
  identityId: string | undefined,
  run: (client: CodexAppServerClient) => Promise<T>,
): Promise<T> {
  const resolved = await resolveCli({
    runtimeId: 'codex',
    binaryName: 'codex',
    envOverride: 'O8_CODEX_BIN',
    extraEnvOverrides: ['CODEX_HOME'],
  });
  const client = new CodexAppServerClient({
    binaryPath: resolved.path,
    codexHome: await resolveCodexHome(identityId),
    requestTimeoutMs: 15_000,
  });
  try {
    await client.initialize('o8-session-control', '1');
    return await run(client);
  } finally {
    await client.close();
  }
}

async function readThread(client: CodexAppServerClient, threadId: string, includeTurns: boolean) {
  const response = record(await client.request('thread/read', { threadId, includeTurns }, 15_000));
  return response ? record(response.thread) : null;
}

function providerFailure(
  note: string,
  originalSession: RuntimeSession,
  reason: RuntimeSessionTransformProviderResult['reason'] = 'provider_error',
  sideEffect: RuntimeSessionTransformProviderResult['sideEffect'] = 'none',
): RuntimeSessionTransformProviderResult {
  return {
    ok: false,
    note,
    reason,
    retryable: sideEffect === 'unknown',
    sideEffect,
    originalSession,
  };
}

function placeholderSession(sessionKey: string, identityId?: string): RuntimeSession {
  return {
    sessionKey,
    runtimeId: 'codex',
    displayName: 'Codex session',
    cwd: '',
    status: 'idle',
    ownership: 'provider',
    sessionCapabilities: { canSendInput: true, canInterrupt: false, canReviewDiffs: true },
    lastActivityAt: new Date(0),
    identityId,
  };
}

export async function transformCodexSession(
  input: RuntimeSessionTransformInput,
): Promise<RuntimeSessionTransformProviderResult> {
  const threadId = threadIdFromSessionKey(input.sessionKey);
  const placeholder = placeholderSession(input.sessionKey, input.identityId);
  if (!threadId) {
    return providerFailure(
      'This Codex surface has no durable provider thread to transform.',
      placeholder,
      'unsupported',
    );
  }

  try {
    return await withCodexAppServer(input.identityId, async (client) => {
      const sourceThread = await readThread(client, threadId, false);
      const originalSession = sourceThread ? sessionFromThread(sourceThread, input.identityId) : null;
      if (!sourceThread || !originalSession) {
        return providerFailure('Codex could not find that durable thread.', placeholder, 'session_not_found');
      }

      if (input.action === 'import') {
        return {
          ok: true,
          note: 'Session added to the o8 catalog without changing provider ownership.',
          originalSession,
          resultingSession: originalSession,
          providerSessionCreated: false,
        };
      }

      if (input.action === 'checkpoint') {
        // App-server exposes durable turn ids through thread/read. Keep the
        // provider reference inside the private catalog; callers only receive
        // the o8 checkpoint id.
        const threadWithTurns = await readThread(client, threadId, true);
        const turns = Array.isArray(threadWithTurns?.turns)
          ? threadWithTurns.turns.map(record).filter((turn): turn is JsonRecord => Boolean(turn))
          : [];
        const completedTurn = turns.findLast((turn) => (
          turn.status === 'completed' && stringValue(turn.id)
        ));
        if (!completedTurn) {
          return providerFailure(
            'This thread has no completed provider turn to checkpoint.',
            originalSession,
            'stale_checkpoint',
          );
        }
        return {
          ok: true,
          note: 'Provider checkpoint resolved.',
          originalSession,
          resultingSession: originalSession,
          providerCheckpointRef: stringValue(completedTurn.id),
          providerSessionCreated: false,
        };
      }

      const providerCheckpointRef = input.providerCheckpointRef?.trim();
      if (!providerCheckpointRef) {
        return providerFailure(
          'A provider checkpoint is required for this transform.',
          originalSession,
          'stale_checkpoint',
        );
      }

      const forkResponse = record(await client.request('thread/fork', {
        threadId,
        lastTurnId: providerCheckpointRef,
        cwd: originalSession.cwd,
        ...(input.operationId ? { threadSource: `o8-session-transform:${input.operationId}` } : {}),
      }, 30_000));
      const resultingThread = forkResponse ? record(forkResponse.thread) : null;
      const resultingSession = resultingThread ? sessionFromThread(resultingThread, input.identityId) : null;
      if (!resultingSession) {
        return providerFailure('Codex forked the thread but returned no durable session identity.', originalSession);
      }
      return {
        ok: true,
        note: input.action === 'rewind'
          ? 'Created a new continuation from the checkpoint; the original thread was preserved.'
          : 'Created a provider-native fork from the checkpoint.',
        originalSession,
        resultingSession,
        providerCheckpointRef,
        providerSessionCreated: true,
      };
    });
  } catch (error) {
    const note = error instanceof Error ? error.message : String(error);
    const stale = /turn|checkpoint|not found|does not exist/i.test(note);
    const sideEffect = error instanceof CodexAppServerRequestError
      ? error.sideEffect
      : 'unknown';
    return providerFailure(
      stale ? 'The selected provider checkpoint is stale or unavailable.' : note,
      placeholder,
      stale ? 'stale_checkpoint' : 'provider_error',
      sideEffect,
    );
  }
}

export async function recoverCodexSessionTransform(
  input: RuntimeSessionTransformRecoveryInput,
): Promise<RuntimeSessionTransformProviderResult | null> {
  const threadId = threadIdFromSessionKey(input.sessionKey);
  if (!threadId) return null;
  try {
    return await withCodexAppServer(input.identityId, async (client) => {
      const sourceThread = await readThread(client, threadId, false);
      const originalSession = sourceThread ? sessionFromThread(sourceThread, input.identityId) : null;
      if (!originalSession) return null;

      let resultingThread: JsonRecord | null = null;
      if (input.resultingSessionKey) {
        const resultingId = threadIdFromSessionKey(input.resultingSessionKey);
        if (resultingId) resultingThread = await readThread(client, resultingId, true);
      } else {
        const listed = record(await client.request('thread/list', {
          limit: 100,
          sortKey: 'created_at',
          sortDirection: 'desc',
          sourceKinds: ['appServer'],
          cwd: originalSession.cwd,
          useStateDbOnly: true,
        }, 15_000));
        const startedAtSeconds = Date.parse(input.startedAt) / 1_000;
        const operationSource = `o8-session-transform:${input.operationId}`;
        const candidates = Array.isArray(listed?.data)
          ? listed.data
            .map(record)
            .filter((thread): thread is JsonRecord => Boolean(
              thread
              && thread.forkedFromId === threadId
              && typeof thread.createdAt === 'number'
              && thread.createdAt >= startedAtSeconds - 2
              && thread.threadSource === operationSource,
            ))
          : [];
        const matching: JsonRecord[] = [];
        for (const candidate of candidates) {
          const candidateId = stringValue(candidate.id);
          if (!candidateId) continue;
          const withTurns = await readThread(client, candidateId, true);
          const turns = Array.isArray(withTurns?.turns)
            ? withTurns.turns.map(record).filter((turn): turn is JsonRecord => Boolean(turn))
            : [];
          const completedTurns = turns.filter((turn) => turn.status === 'completed');
          if (
            stringValue(completedTurns.at(-1)?.id) === input.providerCheckpointRef
            && withTurns
          ) matching.push(withTurns);
        }
        if (matching.length !== 1) return null;
        [resultingThread] = matching;
      }

      const resultingSession = resultingThread ? sessionFromThread(resultingThread, input.identityId) : null;
      if (!resultingSession || resultingThread?.forkedFromId !== threadId) return null;
      return {
        ok: true,
        note: 'Recovered a provider-native continuation after interrupted catalog persistence.',
        originalSession,
        resultingSession,
        providerCheckpointRef: input.providerCheckpointRef,
        providerSessionCreated: true,
      };
    });
  } catch {
    return null;
  }
}
