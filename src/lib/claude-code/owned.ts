import path from 'node:path';

import {
  buildClaudeStreamJsonArgs,
  buildClaudeStreamJsonUserPayload,
} from '@/lib/claude-code/interactive-session';
import {
  createClaudeCodeStreamJsonParser,
  type ClaudeCodeStreamJsonParserEvent,
} from '@/lib/claude-code/stream-json-parser';
import { createOwnedSessionStore } from '@/lib/runtimes/shared/owned-session';
import { MODEL_IDS } from '@/lib/models';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import type {
  OwnedRuntimeAdapter,
  OwnedRunRecord,
  OwnedTailEntry,
  ParsedRunLog,
} from '@/lib/runtimes/shared/owned-session/types';
import { getDataDir } from '@/lib/data-dir-migration';

function eventText(event: ClaudeCodeStreamJsonParserEvent): string {
  switch (event.type) {
    case 'delta':
    case 'thinking':
    case 'plan_step':
      return event.text;
    case 'tool_call':
      return event.preview ?? event.name;
    case 'tool_result':
      return event.preview ?? event.output ?? event.name ?? 'Tool result';
    case 'permission_request':
      return event.text;
    case 'usage':
      return `Usage: ${event.inputTokens} input, ${event.outputTokens} output`;
    case 'done':
      return event.text;
  }
}

function entryKind(event: ClaudeCodeStreamJsonParserEvent): OwnedTailEntry['kind'] {
  if (event.type === 'tool_call') return 'tool';
  if (event.type === 'tool_result') return 'tool-output';
  if (event.type === 'delta' || event.type === 'thinking' || event.type === 'done') return 'message';
  return 'event';
}

function parseClaudeOwnedRunLog(raw: string, run: OwnedRunRecord): ParsedRunLog {
  const parser = createClaudeCodeStreamJsonParser();
  const events = [...parser.pushChunk(raw), ...parser.flush()];
  const entries = events
    .map((event, index): OwnedTailEntry | null => {
      const text = eventText(event).trim();
      if (!text) return null;
      return {
        id: `${run.id}-${index}`,
        kind: entryKind(event),
        label: event.type,
        text,
        timestamp: run.startedAt,
      };
    })
    .filter((entry): entry is OwnedTailEntry => entry !== null);
  const done = events.find((event): event is Extract<ClaudeCodeStreamJsonParserEvent, { type: 'done' }> =>
    event.type === 'done');

  return {
    threadId: done?.sessionId,
    entries,
    outcome: done ? 'finished' : 'running',
    completedTurn: Boolean(done),
  };
}

const claudeCodeOwnedAdapter: OwnedRuntimeAdapter = {
  runtimeId: 'claude-code',
  surfaceIdPrefix: 'claude-code-owned:',
  rootEnvVar: 'CORTEX_IDE_OWNED_CLAUDE_CODE_ROOT',
  rootDefault: path.join(getDataDir(), 'owned-claude-code'),
  binaryName: 'claude',
  binaryEnvOverride: 'O8_CLAUDE_CODE_BIN',
  binaryExtraEnvOverrides: ['CLAUDE_BIN'],
  humanLabel: 'Owned Claude Code',
  squadShortName: 'Claude',
  sessionIdPrefix: 'claude-code-owned-',
  defaultModel: MODEL_IDS.claudeWorkerDefault,
  launchArgs: ({ model, effort }) => buildClaudeStreamJsonArgs(model ?? null, 'bypassPermissions', null, effort),
  launchStdin: ({ prompt }) => buildClaudeStreamJsonUserPayload(prompt),
  resumeArgs: () => null,
  parseRunLog: parseClaudeOwnedRunLog,
  launchGroupLabel: 'Stream-json worker turn',
};

const claudeCodeOwnedStore = createOwnedSessionStore(claudeCodeOwnedAdapter);

export function invalidateOwnedClaudeCodeFleetCache(): void {
  claudeCodeOwnedStore.invalidateFleetCache();
}

export async function archiveOwnedClaudeCodeSession(surfaceId: string) {
  return claudeCodeOwnedStore.archiveSession(surfaceId);
}

export async function sweepOrphanedClaudeCodeSessions(activeSurfaceIds: Set<string>, maxAgeMs: number) {
  return claudeCodeOwnedStore.sweepOrphanedSessions(activeSurfaceIds, maxAgeMs);
}

export async function getOwnedClaudeCodeTelemetrySources(surfaceId: string) {
  return claudeCodeOwnedStore.getTelemetrySources(surfaceId);
}

export async function launchOwnedClaudeCodeSession(request: {
  cwd: string;
  prompt: string;
  model?: string;
  effort?: ThinkingEffort;
}) {
  return claudeCodeOwnedStore.launch(request);
}

export async function getOwnedClaudeCodeFleetAdditions(options?: { fresh?: boolean }) {
  return claudeCodeOwnedStore.getFleetAdditions(options);
}

export async function getOwnedClaudeCodeRuntimeTail(surfaceId: string) {
  return claudeCodeOwnedStore.getRuntimeTail(surfaceId);
}
