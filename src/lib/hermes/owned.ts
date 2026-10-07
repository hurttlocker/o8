import path from 'node:path';

import {
  AcpRequestError,
  type AcpInboundRequest,
  type AcpInitializeResult,
  type AcpRawNotification,
} from '@/lib/acp/client';
import { getDataDir } from '@/lib/data-dir-migration';
import {
  createOwnedAcpSessionStore,
  type OwnedAcpRunRecord,
  type OwnedAcpRuntimeAdapter,
} from '@/lib/runtimes/shared/owned-acp';
import { compactText, formatClock } from '@/lib/runtimes/shared/owned-session/helpers';
import type { OwnedTailEntry } from '@/lib/runtimes/shared/owned-session/types';
import { resolveHermesBinary } from './runtime-resolution';
import { prepareHermesWorkerHome } from './worker-profile';

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  const direct = record(value);
  if (typeof direct?.text === 'string') return direct.text;
  if (!Array.isArray(value)) return '';
  return value.map((item) => {
    const row = record(item);
    if (!row) return '';
    if (typeof row.text === 'string') return row.text;
    return contentText(row.content);
  }).filter(Boolean).join('\n');
}

function handleHermesRequest(request: AcpInboundRequest): unknown {
  if (request.method !== 'session/request_permission') {
    throw new AcpRequestError(-32601, `Unsupported ACP request: ${request.method}`);
  }
  const options = Array.isArray(request.params.options) ? request.params.options : [];
  const allowOnce = options.find((option) => {
    const row = record(option);
    return row?.kind === 'allow_once' && typeof row.optionId === 'string';
  });
  const selected = record(allowOnce);
  return selected && typeof selected.optionId === 'string'
    ? { outcome: { outcome: 'selected', optionId: selected.optionId } }
    : { outcome: { outcome: 'cancelled' } };
}

function validateHermesInitialize(result: AcpInitializeResult): { version?: string } {
  const name = result.agentInfo?.name?.trim() ?? '';
  if (result.protocolVersion !== 1 || !name.toLowerCase().includes('hermes')) {
    throw new Error('Hermes ACP initialize returned an incompatible server identity.');
  }
  return { version: result.agentInfo?.version?.trim() || undefined };
}

function hermesSupportsResume(result: AcpInitializeResult): boolean {
  const capabilities = record(result.agentCapabilities);
  const sessions = record(capabilities?.sessionCapabilities);
  return capabilities?.loadSession === true || Boolean(sessions && 'resume' in sessions);
}

function hermesSummary(notification: AcpRawNotification): string | null {
  if (notification.method !== 'session/update') return null;
  const update = record(notification.params.update);
  if (update?.sessionUpdate !== 'agent_message_chunk') return null;
  const text = contentText(update.content).trim();
  return text || null;
}

function parseHermesRunLog(
  raw: string,
  run: OwnedAcpRunRecord,
): { entries: OwnedTailEntry[]; completedTurn: boolean; finishReason?: string } {
  const fallbackTs = run.finishedAt ?? run.startedAt;
  const entries: OwnedTailEntry[] = [{
    id: `${run.id}:prompt`,
    kind: 'event',
    label: run.mode === 'launch' ? 'Launch prompt' : 'Resume prompt',
    text: compactText(run.prompt, 400),
    timestamp: run.startedAt,
    timestampLabel: formatClock(run.startedAt),
  }];
  let completedTurn = false;
  let finishReason: string | undefined;
  let message: { index: number; text: string } | null = null;

  const flushMessage = () => {
    if (!message?.text.trim()) {
      message = null;
      return;
    }
    entries.push({
      id: `${run.id}:assistant:${message.index}`,
      kind: 'message',
      label: 'Hermes',
      text: compactText(message.text, 2_000),
      timestamp: fallbackTs,
      timestampLabel: formatClock(fallbackTs),
    });
    message = null;
  };

  for (const [index, line] of raw.split('\n').entries()) {
    if (!line.trim().startsWith('{')) continue;
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (frame.method === 'session/update') {
      const params = record(frame.params);
      const update = record(params?.update);
      if (update?.sessionUpdate === 'agent_message_chunk') {
        const text = contentText(update.content);
        if (text) {
          message ??= { index, text: '' };
          message.text += text;
        }
        continue;
      }
      if (update?.sessionUpdate === 'tool_call') {
        flushMessage();
        entries.push({
          id: `${run.id}:tool:${String(update.toolCallId ?? index)}`,
          kind: 'tool',
          label: typeof update.title === 'string' ? update.title : 'tool',
          text: compactText(JSON.stringify(update.rawInput ?? {}), 800),
          timestamp: fallbackTs,
          timestampLabel: formatClock(fallbackTs),
        });
      } else if (update?.sessionUpdate === 'tool_call_update' && update.status === 'completed') {
        flushMessage();
        entries.push({
          id: `${run.id}:tool-result:${String(update.toolCallId ?? index)}`,
          kind: 'tool-output',
          label: typeof update.title === 'string' ? update.title : 'tool result',
          text: compactText(contentText(update.content) || JSON.stringify(update.content ?? {}), 800),
          timestamp: fallbackTs,
          timestampLabel: formatClock(fallbackTs),
        });
      }
      continue;
    }

    if (frame.method === 'o8/session.prompt.settled') {
      flushMessage();
      const params = record(frame.params);
      completedTurn = params?.outcome === 'finished';
      finishReason = typeof params?.stopReason === 'string' ? params.stopReason : undefined;
    }
  }
  flushMessage();
  return { entries, completedTurn, finishReason };
}

const hermesStore = createOwnedAcpSessionStore({
  runtimeId: 'hermes',
  surfaceIdPrefix: 'hermes-owned:',
  sessionIdPrefix: 'hermes-owned-',
  rootEnvVar: 'O8_OWNED_HERMES_ROOT',
  rootDefault: path.join(getDataDir(), 'owned-hermes'),
  binaryName: 'hermes',
  humanLabel: 'Hermes',
  squadShortName: 'Hermes',
  async resolveLaunch(session) {
    const command = resolveHermesBinary();
    if (!command) throw new Error('Hermes CLI is not installed.');
    const worker = prepareHermesWorkerHome(session.sessionDir);
    return {
      command,
      args: ['acp', '--accept-hooks'],
      commandIdentity: path.basename(command),
      env: { HOME: worker.home },
    };
  },
  validateInitialize: validateHermesInitialize,
  supportsResume: hermesSupportsResume,
  handleRequest: handleHermesRequest,
  notificationSummary: hermesSummary,
  parseRunLog: parseHermesRunLog,
} satisfies OwnedAcpRuntimeAdapter);

export const launchOwnedHermesSession = hermesStore.launch.bind(hermesStore);
export const continueOwnedHermesSession = hermesStore.resume.bind(hermesStore);
export const interruptOwnedHermesSession = hermesStore.interrupt.bind(hermesStore);
export const getOwnedHermesFleetAdditions = hermesStore.getFleetAdditions.bind(hermesStore);
export const getOwnedHermesRuntimeTail = hermesStore.getRuntimeTail.bind(hermesStore);
export const getOwnedHermesReviewPacket = hermesStore.getReviewPacket.bind(hermesStore);
export const getOwnedHermesTelemetrySources = hermesStore.getTelemetrySources.bind(hermesStore);
export const setOwnedHermesReviewDisposition = hermesStore.setReviewDisposition.bind(hermesStore);
export const archiveOwnedHermesSession = hermesStore.archiveSession.bind(hermesStore);
export const ownedHermesSessionState = hermesStore.sessionState.bind(hermesStore);
export const invalidateOwnedHermesFleetCache = hermesStore.invalidateFleetCache.bind(hermesStore);
