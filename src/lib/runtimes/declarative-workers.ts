import path from 'node:path';

import {
  getRuntimeCapability,
  listDeclarativeRuntimes,
  type DeclarativeParserProfile,
  type OrchestratorRuntime,
} from '@/lib/orchestrator/runtime-capabilities';
import type { AgentRuntime } from './types';
import { createDeclarativeAgentRuntime } from './shared/declarative-agent-runtime';
import {
  registerDeclarativeCostParser,
  type DeclarativeCostFormat,
} from './shared/declarative-cost-parser';
import {
  registerDeclarativeOwnedRuntime,
  type DeclarativeOwnedRuntimeConfig,
  type DeclarativeRunLogPatterns,
} from './shared/owned-session';
import { getDataDir } from '@/lib/data-dir-migration';

export interface DeclarativeWorkerConfig extends DeclarativeOwnedRuntimeConfig {
  runtimeId: OrchestratorRuntime;
  displayName: string;
  costFormat: DeclarativeCostFormat;
}

function textOutput(label: string): DeclarativeRunLogPatterns {
  return {
    patterns: [{
      linePattern: /^(.+)$/,
      kind: 'message',
      label,
      textGroup: 1,
      completedTurn: true,
    }],
  };
}

function copilotJsonl(): DeclarativeRunLogPatterns {
  return {
    eventTypePaths: ['type'],
    timestampPaths: ['timestamp'],
    patterns: [
      {
        eventType: /^(session\.start|session\.resume)$/,
        threadIdPaths: ['data.sessionId'],
      },
      {
        eventType: 'assistant.message',
        kind: 'message',
        label: 'Copilot',
        textPaths: ['data.content'],
      },
      {
        eventType: 'tool.execution_start',
        kind: 'tool',
        labelPaths: ['data.toolName'],
        textPaths: ['data.arguments'],
      },
      {
        eventType: 'tool.execution_complete',
        kind: 'tool-output',
        labelPaths: ['data.toolName'],
        textPaths: ['data.result', 'data.error'],
      },
      {
        eventType: /^(assistant\.turn_end|result|session\.shutdown)$/,
        kind: 'event',
        label: 'Run complete',
        textPaths: ['data.result', 'data.usage', 'data'],
        completedTurn: true,
      },
      {
        eventType: /^(error|session\.error)$/,
        kind: 'event',
        label: 'Error',
        textPaths: ['data.message', 'data.error', 'message', 'error'],
      },
    ],
    includeUnmatchedJson: true,
  };
}

function qwenStreamJson(): DeclarativeRunLogPatterns {
  return {
    patterns: [
      {
        eventType: 'init',
        threadIdPaths: ['session_id', 'sessionId', 'id'],
      },
      {
        eventType: /^(message|assistant|assistant_message)$/,
        kind: 'message',
        label: 'Qwen',
        textPaths: ['message.content', 'content', 'text'],
      },
      {
        eventType: /^(tool_use|tool_call)$/,
        kind: 'tool',
        labelPaths: ['tool', 'name', 'tool_name'],
        textPaths: ['input', 'arguments', 'args'],
      },
      {
        eventType: /^(tool_result|tool_output)$/,
        kind: 'tool-output',
        label: 'Tool result',
        textPaths: ['output', 'result', 'content'],
      },
      {
        eventType: /^(result|complete|completed)$/,
        kind: 'event',
        label: 'Run complete',
        textPaths: ['result', 'usage', 'stats'],
        completedTurn: true,
      },
      {
        eventType: 'error',
        kind: 'event',
        label: 'Error',
        textPaths: ['message', 'error', 'detail'],
      },
    ],
    includeUnmatchedJson: true,
  };
}

function openHandsNdjson(): DeclarativeRunLogPatterns {
  return {
    eventTypePaths: ['type', 'event', 'kind'],
    timestampPaths: ['timestamp', 'created_at', 'createdAt'],
    patterns: [
      {
        eventType: /^(init|session_start|conversation_started)$/,
        threadIdPaths: ['conversation_id', 'session_id', 'sessionId', 'id'],
      },
      {
        eventType: /^(message|assistant|assistant_message|agent_message)$/,
        kind: 'message',
        label: 'OpenHands',
        textPaths: ['message.content', 'content', 'text', 'message'],
      },
      {
        eventType: /^(tool|tool_use|tool_call|action)$/,
        kind: 'tool',
        labelPaths: ['tool', 'name', 'action'],
        textPaths: ['input', 'arguments', 'args', 'message'],
      },
      {
        eventType: /^(tool_result|tool_output|observation)$/,
        kind: 'tool-output',
        label: 'Tool result',
        textPaths: ['output', 'result', 'content', 'message'],
      },
      {
        eventType: /^(result|finish|finished|complete|completed|conversation_completed)$/,
        kind: 'event',
        label: 'Run complete',
        textPaths: ['message', 'result', 'usage'],
        completedTurn: true,
      },
      {
        eventType: /^(error|failed)$/,
        kind: 'event',
        label: 'Error',
        textPaths: ['message', 'error', 'detail'],
      },
    ],
    includeUnmatchedJson: true,
  };
}

function parserForProfile(profile: DeclarativeParserProfile, label: string): DeclarativeRunLogPatterns {
  if (profile === 'copilot-jsonl') return copilotJsonl();
  if (profile === 'openhands-ndjson') return openHandsNdjson();
  if (profile === 'qwen-stream-json') return qwenStreamJson();
  return textOutput(label);
}

function envToken(runtimeId: OrchestratorRuntime): string {
  return runtimeId.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase();
}

function materializeDeclarativeWorkerConfig(runtimeId: OrchestratorRuntime): DeclarativeWorkerConfig {
  const capability = getRuntimeCapability(runtimeId);
  const manifest = capability.declarative;
  if (!manifest) throw new Error(`Runtime ${runtimeId} has no declarative adapter manifest.`);
  const token = envToken(runtimeId);
  return {
    runtimeId,
    displayName: capability.label,
    surfaceIdPrefix: `${runtimeId}-owned:`,
    rootEnvVar: `O8_OWNED_${token}_ROOT`,
    rootDefault: path.join(getDataDir(), `owned-${runtimeId}`),
    binaryName: capability.binaryName,
    binaryEnvOverride: `O8_${token}_BIN`,
    humanLabel: `Owned ${capability.shortLabel}`,
    squadShortName: capability.shortLabel,
    sessionIdPrefix: `${runtimeId}-owned-`,
    launchArgs: manifest.launchArgs,
    resumeArgs: manifest.resumeArgs,
    sessionFileName: manifest.sessionFileName,
    parseRunLog: parserForProfile(manifest.parserProfile, capability.label),
    ...(manifest.extraSpawnEnv
      ? { extraSpawnEnv: () => ({ ...manifest.extraSpawnEnv }) }
      : {}),
    costFormat: manifest.costFormat,
  };
}

export const DECLARATIVE_WORKER_CONFIGS: readonly DeclarativeWorkerConfig[] =
  listDeclarativeRuntimes().map(materializeDeclarativeWorkerConfig);

const registrations = DECLARATIVE_WORKER_CONFIGS.map((config) => {
  const { displayName, costFormat, ...ownedConfig } = config;
  const registration = registerDeclarativeOwnedRuntime(ownedConfig);
  registerDeclarativeCostParser(config.runtimeId, costFormat);
  return {
    ...registration,
    runtime: createDeclarativeAgentRuntime({
      runtimeId: config.runtimeId,
      displayName,
      surfaceIdPrefix: config.surfaceIdPrefix,
      supportsResume: config.resumeArgs !== null,
      costTelemetry: true,
    }, registration.store),
  };
});

export const declarativeWorkerRuntimes: AgentRuntime[] = registrations.map((entry) => entry.runtime);

export function invalidateDeclarativeWorkerFleets(): void {
  for (const registration of registrations) registration.store.invalidateFleetCache();
}
