/**
 * Declarative opencode owned-session adapter.
 *
 * Binary: `opencode` (npm `opencode-ai`). Sessions live under
 * ~/.o8/owned-opencode/ and resume through `--session <ses_xxx>`.
 */

import os from 'node:os';
import path from 'node:path';
import { MODEL_IDS } from '@/lib/models';
import { registerDeclarativeOwnedRuntime } from '@/lib/runtimes/shared/owned-session';

const OPENCODE_OWNED_ROOT = process.env.O8_OWNED_OPENCODE_ROOT
  ?? path.join(os.homedir(), '.o8', 'owned-opencode');

export const OPENCODE_STDERR_NOISE_PATTERNS: RegExp[] = [
  /\[opencode\]\s+loading config from/i,
  /warn:\s+mcp server '[^']+' not connected/i,
  /warn:\s+failed to connect to mcp server/i,
  /warn:\s+no model specified/i,
  /debug:/i,
  /opencode\/storage/i,
];

const opencodeRegistration = registerDeclarativeOwnedRuntime({
  runtimeId: 'opencode',
  surfaceIdPrefix: 'opencode-owned:',
  rootEnvVar: 'O8_OWNED_OPENCODE_ROOT',
  rootDefault: OPENCODE_OWNED_ROOT,
  binaryName: 'opencode',
  binaryEnvOverride: 'O8_OPENCODE_BIN',
  humanLabel: 'Owned opencode',
  squadShortName: 'opencode',
  sessionIdPrefix: 'opencode-owned-',
  defaultModel: MODEL_IDS.opencodeDefault,
  launchArgs: [
    'run',
    '{{prompt}}',
    '--format', 'json',
    '--model', '{{model}}',
  ],
  resumeArgs: [
    'run',
    '{{prompt}}',
    '--format', 'json',
    '--session', '{{threadId}}',
    { when: 'model', args: ['--model', '{{model}}'] },
  ],
  parseRunLog: {
    patterns: [
      {
        eventType: 'init',
        threadIdPaths: ['sessionId', 'session_id', 'id'],
        threadIdPattern: /^ses_/,
      },
      {
        eventType: 'message',
        when: { path: 'role', equals: 'assistant' },
        kind: 'message',
        label: 'opencode',
        textPaths: ['content'],
      },
      {
        eventType: 'tool_use',
        kind: 'tool',
        labelPaths: ['tool', 'name', 'tool_name'],
        textPaths: ['input', 'args', 'arguments'],
      },
      {
        eventType: 'tool_result',
        kind: 'tool-output',
        label: 'Tool result',
        textPaths: ['output', 'result', 'content'],
      },
      {
        eventType: 'result',
        kind: 'event',
        label: 'Run complete',
        textPaths: ['usage', 'finishReason', 'finish_reason'],
        completedTurn: true,
      },
      {
        eventType: 'error',
        kind: 'event',
        label: 'Error',
        textPaths: ['message', 'error', 'detail'],
      },
      {
        linePattern: /(rate.?limit|auth.?fail|unauthorized|invalid.?api.?key)/i,
        kind: 'event',
        label: 'Runtime error',
      },
    ],
    includeUnmatchedJson: true,
  },
  stderrNoise: OPENCODE_STDERR_NOISE_PATTERNS,
});

export const opencodeAdapter = opencodeRegistration.adapter;

const store = opencodeRegistration.store;

export const launchOwnedOpencodeSession = store.launch.bind(store);
export const continueOwnedOpencodeSession = store.resume.bind(store);
export const interruptOwnedOpencodeSession = store.interrupt.bind(store);
export const getOwnedOpencodeFleetAdditions = store.getFleetAdditions.bind(store);
export const getOwnedOpencodeRuntimeTail = store.getRuntimeTail.bind(store);
export const getOwnedOpencodeReviewPacket = store.getReviewPacket.bind(store);
export const getOwnedOpencodeTelemetrySources = store.getTelemetrySources.bind(store);
export const setOwnedOpencodeReviewDisposition = store.setReviewDisposition.bind(store);
export const invalidateOwnedOpencodeFleetCache = store.invalidateFleetCache.bind(store);
export const archiveOwnedOpencodeSession = store.archiveSession.bind(store);
export const ownedOpencodeSessionState = store.sessionState.bind(store);
export const sweepOrphanedOpencodeSessions = store.sweepOrphanedSessions.bind(store);
