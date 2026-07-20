import os from 'node:os';
import path from 'node:path';

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

interface DeclarativeWorkerConfig extends DeclarativeOwnedRuntimeConfig {
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

export const DECLARATIVE_WORKER_CONFIGS: readonly DeclarativeWorkerConfig[] = [
  {
    runtimeId: 'openhands',
    displayName: 'OpenHands',
    surfaceIdPrefix: 'openhands-owned:',
    rootEnvVar: 'O8_OWNED_OPENHANDS_ROOT',
    rootDefault: path.join(os.homedir(), '.o8', 'owned-openhands'),
    binaryName: 'openhands',
    binaryEnvOverride: 'O8_OPENHANDS_BIN',
    humanLabel: 'Owned OpenHands',
    squadShortName: 'OpenHands',
    sessionIdPrefix: 'openhands-owned-',
    launchArgs: ['--headless', '--json', '-t', '{{prompt}}'],
    resumeArgs: null,
    parseRunLog: openHandsNdjson(),
    costFormat: 'structured',
  },
  {
    runtimeId: 'goose',
    displayName: 'Goose',
    surfaceIdPrefix: 'goose-owned:',
    rootEnvVar: 'O8_OWNED_GOOSE_ROOT',
    rootDefault: path.join(os.homedir(), '.o8', 'owned-goose'),
    binaryName: 'goose',
    binaryEnvOverride: 'O8_GOOSE_BIN',
    humanLabel: 'Owned Goose',
    squadShortName: 'Goose',
    sessionIdPrefix: 'goose-owned-',
    launchArgs: ['run', '-t', '{{prompt}}', '--max-turns', '100'],
    resumeArgs: null,
    parseRunLog: textOutput('Goose'),
    extraSpawnEnv: () => ({ GOOSE_MODE: 'auto', GOOSE_MAX_TURNS: '100' }),
    costFormat: 'text',
  },
  {
    runtimeId: 'qwen',
    displayName: 'Qwen Code',
    surfaceIdPrefix: 'qwen-owned:',
    rootEnvVar: 'O8_OWNED_QWEN_ROOT',
    rootDefault: path.join(os.homedir(), '.o8', 'owned-qwen'),
    binaryName: 'qwen',
    binaryEnvOverride: 'O8_QWEN_BIN',
    humanLabel: 'Owned Qwen',
    squadShortName: 'Qwen',
    sessionIdPrefix: 'qwen-owned-',
    launchArgs: ['-p', '{{prompt}}', '--yolo', '--output-format', 'stream-json'],
    resumeArgs: null,
    parseRunLog: qwenStreamJson(),
    costFormat: 'structured',
  },
  {
    runtimeId: 'kimi',
    displayName: 'Kimi Code',
    surfaceIdPrefix: 'kimi-owned:',
    rootEnvVar: 'O8_OWNED_KIMI_ROOT',
    rootDefault: path.join(os.homedir(), '.o8', 'owned-kimi'),
    binaryName: 'kimi',
    binaryEnvOverride: 'O8_KIMI_BIN',
    humanLabel: 'Owned Kimi',
    squadShortName: 'Kimi',
    sessionIdPrefix: 'kimi-owned-',
    launchArgs: ['-p', '{{prompt}}'],
    resumeArgs: null,
    parseRunLog: textOutput('Kimi'),
    costFormat: 'text',
  },
  {
    runtimeId: 'aider',
    displayName: 'Aider',
    surfaceIdPrefix: 'aider-owned:',
    rootEnvVar: 'O8_OWNED_AIDER_ROOT',
    rootDefault: path.join(os.homedir(), '.o8', 'owned-aider'),
    binaryName: 'aider',
    binaryEnvOverride: 'O8_AIDER_BIN',
    humanLabel: 'Owned Aider',
    squadShortName: 'Aider',
    sessionIdPrefix: 'aider-owned-',
    launchArgs: ['--message', '{{prompt}}', '--yes-always', '--auto-test'],
    resumeArgs: null,
    parseRunLog: textOutput('Aider'),
    costFormat: 'text',
  },
];

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
