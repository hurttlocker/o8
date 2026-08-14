import path from 'node:path';

import {
  AcpRequestError,
  type AcpInboundRequest,
  type AcpRawNotification,
} from '@/lib/acp/client';
import { getDataDir } from '@/lib/data-dir-migration';
import {
  createOwnedAcpSessionStore,
  type OwnedAcpRuntimeAdapter,
} from '@/lib/runtimes/shared/owned-acp';
import {
  parseDeepSeekHarnessRunLog,
  validateDeepSeekHarnessInitialize,
} from './protocol';
import { resolveDeepSeekHarnessLaunch } from './runtime-resolution';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function handleHarnessRequest(request: AcpInboundRequest): unknown {
  if (request.method !== 'session/request_permission') {
    throw new AcpRequestError(-32601, `Unsupported ACP request: ${request.method}`);
  }
  const options = Array.isArray(request.params.options) ? request.params.options : [];
  const allowOnce = options.find((option) => (
    isRecord(option)
    && option.kind === 'allow_once'
    && typeof option.optionId === 'string'
  ));
  return allowOnce && typeof allowOnce.optionId === 'string'
    ? { outcome: { outcome: 'selected', optionId: allowOnce.optionId } }
    : { outcome: { outcome: 'cancelled' } };
}

function harnessSummary(notification: AcpRawNotification): string | null {
  if (notification.method !== 'session/update') return null;
  const update = isRecord(notification.params.update) ? notification.params.update : null;
  if (update?.sessionUpdate !== 'agent_message_chunk') return null;
  const content = isRecord(update.content) ? update.content : null;
  return typeof content?.text === 'string' && content.text.trim() ? content.text.trim() : null;
}

const deepSeekHarnessStore = createOwnedAcpSessionStore({
  runtimeId: 'deepseek-harness',
  surfaceIdPrefix: 'deepseek-harness-owned:',
  sessionIdPrefix: 'deepseek-harness-owned-',
  rootEnvVar: 'O8_OWNED_DEEPSEEK_HARNESS_ROOT',
  rootDefault: path.join(getDataDir(), 'owned-deepseek-harness'),
  binaryName: 'dsh-acp-demo',
  humanLabel: 'Owned DeepSeek Harness',
  squadShortName: 'DeepSeek Harness',
  defaultModel: 'deepseek-v4-pro',
  async resolveLaunch(session) {
    const launch = await resolveDeepSeekHarnessLaunch({ model: session.model });
    return {
      command: launch.command,
      args: launch.args,
      commandIdentity: path.basename(launch.command),
      version: launch.version,
      env: {
        DSH_SNAPSHOT_SESSIONS_ROOT: path.join(session.sessionDir, 'harness-sessions'),
        FORCE_COLOR: '0',
        NO_COLOR: '1',
      },
    };
  },
  validateInitialize(result) {
    const initialized = validateDeepSeekHarnessInitialize(result);
    return { version: initialized.agentInfo.version };
  },
  supportsResume(result) {
    const capabilities = isRecord(result.agentCapabilities?.sessionCapabilities)
      ? result.agentCapabilities.sessionCapabilities
      : null;
    return Boolean(capabilities && 'resume' in capabilities);
  },
  handleRequest: handleHarnessRequest,
  notificationSummary: harnessSummary,
  parseRunLog: parseDeepSeekHarnessRunLog,
} satisfies OwnedAcpRuntimeAdapter);

export const launchOwnedDeepSeekHarnessSession = deepSeekHarnessStore.launch.bind(deepSeekHarnessStore);
export const continueOwnedDeepSeekHarnessSession = deepSeekHarnessStore.resume.bind(deepSeekHarnessStore);
export const interruptOwnedDeepSeekHarnessSession = deepSeekHarnessStore.interrupt.bind(deepSeekHarnessStore);
export const getOwnedDeepSeekHarnessFleetAdditions = deepSeekHarnessStore.getFleetAdditions.bind(deepSeekHarnessStore);
export const getOwnedDeepSeekHarnessRuntimeTail = deepSeekHarnessStore.getRuntimeTail.bind(deepSeekHarnessStore);
export const getOwnedDeepSeekHarnessReviewPacket = deepSeekHarnessStore.getReviewPacket.bind(deepSeekHarnessStore);
export const getOwnedDeepSeekHarnessTelemetrySources = deepSeekHarnessStore.getTelemetrySources.bind(deepSeekHarnessStore);
export const setOwnedDeepSeekHarnessReviewDisposition = deepSeekHarnessStore.setReviewDisposition.bind(deepSeekHarnessStore);
export const archiveOwnedDeepSeekHarnessSession = deepSeekHarnessStore.archiveSession.bind(deepSeekHarnessStore);
export const ownedDeepSeekHarnessSessionState = deepSeekHarnessStore.sessionState.bind(deepSeekHarnessStore);
export const invalidateOwnedDeepSeekHarnessFleetCache = deepSeekHarnessStore.invalidateFleetCache.bind(deepSeekHarnessStore);
