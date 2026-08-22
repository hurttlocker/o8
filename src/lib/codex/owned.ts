/**
 * Codex owned-session adapter.
 *
 * This file is the Codex-specific adapter on top of the generic
 * owned-session primitive (`@/lib/runtimes/shared/owned-session`).
 *
 * Every public export here preserves the exact same signature and semantics
 * the Codex implementation had before Wave 2b. Callers across the codebase
 * (runtime registry, mobile history, API routes, command-center snapshot)
 * continue to import the same names with no behavioural change.
 *
 * What's Codex-specific and lives here:
 *   - launchArgs / resumeArgs (Codex exec CLI flags, danger-full-access sandbox)
 *   - parseRunLog (Codex JSONL stream: thread.started, turn.started, event_msg,
 *     response_item, item.started/completed, turn.completed, plus tool paths)
 *   - parseRunEvidence (extract agent_message + command_execution items)
 *   - stderr noise patterns (MCP teardown warnings, etc.)
 *
 * What moved to the shared primitive:
 *   - spawn/launch/resume/interrupt pipelines
 *   - tmux bridge spawn + detached spawn fallback
 *   - metadata JSON read/write, runs/ directory layout
 *   - lifecycle derivation + surface/status/current-task building
 *   - stale-session filtering, TTL fleet cache + inflight dedupe + generation
 *   - auto-retry logic
 *   - review packet assembly (wraps getRuntimeRepoReview + worktree join)
 */

import path from 'node:path';
import os from 'node:os';
import type { RuntimeReviewCommandEvidence } from '@/lib/fleet/types';
import {
  compactText,
  createOwnedSessionStore,
  previewText,
  type OwnedRunEvidence,
  type OwnedRunOutcome,
  type OwnedRunRecord,
  type OwnedRuntimeAdapter,
  type OwnedTailEntry,
  type ParsedRunLog,
} from '@/lib/runtimes/shared/owned-session';
import { codexModelArgs } from './local-model';
import { resolveCodexReasoningEffort } from './reasoning-effort';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import { getDataDir } from '@/lib/data-dir-migration';

// Re-export the fleet additions shape under its original Codex name.
export type { OwnedCodexFleetAdditions } from '@/lib/runtimes/shared/owned-session';

// ── Codex-specific types (preserved signatures) ──────────────────────────────

export type OwnedCodexLaunchRequest = {
  cwd: string;
  prompt: string;
  clientMutationId?: string;
  model?: string;
  effort?: ThinkingEffort;
  laneId?: string;
  packetId?: string;
};

export type OwnedCodexLaunchResponse = {
  ok: boolean;
  runtime: 'codex';
  surfaceId: string;
  note: string;
};

type OwnedReviewDisposition = 'watching' | 'resolved';

// ── Codex JSONL helpers ──────────────────────────────────────────────────────

function safeObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      return safeObject(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return safeObject(value);
}

function readStringField(source: Record<string, unknown> | null, ...keys: string[]) {
  if (!source) return undefined;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function readNestedStringField(source: Record<string, unknown> | null, keyPath: string[]) {
  let current: unknown = source;
  for (const key of keyPath) {
    const next = safeObject(current)?.[key];
    if (next == null) return undefined;
    current = next;
  }
  return typeof current === 'string' && current.trim() ? current.trim() : undefined;
}

function extractStructuredText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        const record = safeObject(item);
        if (!record) return '';
        const nestedText = readStringField(record, 'text', 'message', 'summary_text');
        return nestedText ?? '';
      })
      .filter(Boolean)
      .join(' ');
  }

  const record = safeObject(value);
  if (!record) return '';

  const direct = readStringField(record, 'text', 'message', 'summary_text', 'output');
  if (direct) return direct;

  const content = record.content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        const entry = safeObject(item);
        if (!entry) return '';
        if (entry.type === 'input_text' || entry.type === 'output_text') {
          return typeof entry.text === 'string' ? entry.text : '';
        }
        return readStringField(entry, 'text') ?? '';
      })
      .filter(Boolean)
      .join(' ');
  }

  return '';
}

function formatClock(timestampIso?: string) {
  if (!timestampIso) return undefined;
  const date = new Date(timestampIso);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function parseEntryTimestamp(value: unknown, fallbackIso: string) {
  const timestamp = typeof value === 'string' && value.trim() ? value : fallbackIso;
  return {
    timestamp,
    timestampLabel: formatClock(timestamp) ?? formatClock(fallbackIso),
  };
}

function humanizeToolName(value?: string) {
  const raw = (value ?? '').trim();
  if (!raw) return 'tool';
  return raw.replace(/[_-]+/g, ' ').trim();
}

function collectToolPaths(payload: Record<string, unknown> | null): string[] {
  const candidates = [
    readStringField(payload, 'path', 'filePath', 'file_path', 'target_file', 'filename', 'fileName'),
    readNestedStringField(payload, ['input', 'path']),
    readNestedStringField(payload, ['input', 'file_path']),
    readNestedStringField(payload, ['input', 'filePath']),
    readNestedStringField(payload, ['arguments', 'path']),
    readNestedStringField(payload, ['arguments', 'file_path']),
    readNestedStringField(payload, ['arguments', 'filePath']),
  ].filter((value): value is string => Boolean(value));

  return [...new Set(candidates)];
}

function describeToolActivity(toolName: string, rawInput: unknown): string {
  const input = parseJsonObject(rawInput);
  const normalizedName = toolName.trim();
  const command = readStringField(input, 'cmd', 'command', 'parsed_cmd', 'interaction_input')
    ?? readNestedStringField(input, ['command', 'cmd'])
    ?? readNestedStringField(input, ['input', 'cmd'])
    ?? readNestedStringField(input, ['input', 'command'])
    ?? readNestedStringField(input, ['arguments', 'cmd'])
    ?? readNestedStringField(input, ['arguments', 'command']);

  if (command && (
    normalizedName === 'exec_command'
    || normalizedName === 'shell_command'
    || normalizedName === 'run_user_shell_command'
    || normalizedName === 'command_execution'
  )) {
    return `Run ${compactText(command, 180)}`;
  }

  const paths = collectToolPaths(input);
  if (paths.length > 0) {
    const pathList = compactText(paths.join(', '), 180);
    if (normalizedName === 'apply_patch') return `Edit ${pathList}`;
    if (normalizedName === 'view_image') return `Inspect ${pathList}`;
    if (normalizedName === 'list_files') return `List files near ${pathList}`;
    if (normalizedName === 'read_file') return `Read ${pathList}`;
    if (normalizedName === 'write_file') return `Write ${pathList}`;
    if (normalizedName === 'grep' || normalizedName === 'search') return `Search ${pathList}`;
  }

  if (normalizedName === 'update_plan') return 'Update plan';
  if (normalizedName === 'apply_patch') return 'Apply patch';
  if (normalizedName === 'list_files') return 'List files';
  if (normalizedName === 'read_file') return 'Read file';
  if (normalizedName === 'write_file') return 'Write file';
  if (normalizedName === 'view_image') return 'Inspect image';

  return `Use ${humanizeToolName(normalizedName)}`;
}

function toolOutputPreview(value: unknown) {
  const text = extractStructuredText(value);
  return compactText(text, 500);
}

// ── Codex CLI argv builders ──────────────────────────────────────────────────

// Codex CLI 0.130.0 injects the hosted `image_generation` tool defaulted to a
// nonexistent `gpt-image-2` model, which OpenAI 400s on every turn — killing
// dispatch at spawn. o8 workers write code, never images, so disable it. Scoped
// to o8-dispatched workers; the user's interactive Codex.app is untouched.
const DISABLE_IMAGE_TOOL = ['-c', 'tools.image_generation=false'];

// #1402 — dispatched workers run with the user's ~/.codex/config.toml IGNORED.
// Inherited MCP servers were killing workers: a dead/auth-broken HTTP MCP entry
// makes rmcp transport workers crash-loop at spawn (slow launches) and the
// session-cleanup DELETE-404 signature preceded 6 silent worker deaths in one
// night. Workers never need MCP — repo answers come from the `o8 ask` CLI and
// reports go through `o8 packet report`. Everything a worker DOES need (model,
// effort, sandbox, image-tool off) is passed by flag. The user's interactive
// Codex and the codex orchestrator session are untouched.
const IGNORE_USER_CONFIG = ['--ignore-user-config'];

/**
 * Codex reasoning-effort flag. Emitted ONLY for an explicit tier — undefined /
 * 'adaptive' → [] so the launch stays at Codex's default (parity: unset effort
 * produces byte-identical args to before this feature). `max`/`ultra` pass
 * through ONLY on gpt-5.6-sol; every other model clamps to `xhigh` (shared with
 * the orchestrator via resolveCodexReasoningEffort).
 */
export function codexReasoningEffortArgs(effort?: ThinkingEffort, model?: string): string[] {
  if (!effort || effort === 'adaptive') return [];
  return ['-c', `model_reasoning_effort=${resolveCodexReasoningEffort(effort, model)}`];
}

export function codexLaunchArgs(ctx: { cwd: string; prompt: string; model?: string; effort?: ThinkingEffort }): string[] {
  return [
    'exec',
    '--json',
    '--dangerously-bypass-approvals-and-sandbox',
    '-s',
    'danger-full-access',
    ...DISABLE_IMAGE_TOOL,
    ...IGNORE_USER_CONFIG,
    '-C',
    ctx.cwd,
    // `ollama:<model>` / `lmstudio:<model>` → run this worker on a LOCAL model
    // (--oss --local-provider …); a plain name → --model; empty → Codex default.
    ...codexModelArgs(ctx.model),
    // Per-runtime effort surface — no-op unless an explicit tier was requested.
    ...codexReasoningEffortArgs(ctx.effort, ctx.model),
    ctx.prompt,
  ];
}

export function codexResumeArgs(ctx: { threadId: string; prompt: string; model?: string }): string[] {
  return [
    'exec',
    'resume',
    ctx.threadId,
    '--json',
    // NOTE: `codex exec resume` accepts --dangerously-bypass-approvals-and-sandbox
    // but has NO `-s/--sandbox` flag (unlike `codex exec`) — passing `-s` makes the
    // CLI exit 2 before the turn starts. Live-hit 2026-07-05: every steer-resume
    // (#1415) failed silently until this was dropped.
    '--dangerously-bypass-approvals-and-sandbox',
    ...DISABLE_IMAGE_TOOL,
    ...IGNORE_USER_CONFIG,
    ctx.prompt,
  ];
}

// ── Codex JSONL stdout parser ────────────────────────────────────────────────

export function codexParseRunLog(
  raw: string,
  run: OwnedRunRecord,
  fallbackTimestamp = run.finishedAt ?? run.startedAt,
): ParsedRunLog {
  const entries: OwnedTailEntry[] = [
    {
      id: `${run.id}:prompt`,
      kind: 'event',
      label: run.mode === 'launch' ? 'Launch prompt' : 'Resume prompt',
      text: compactText(run.prompt, 400),
      timestamp: run.startedAt,
      timestampLabel: formatClock(run.startedAt),
    },
  ];
  let threadId: string | undefined;
  let noiseIndex = 0;
  let completedTurn = false;

  for (const [lineIndex, line] of raw.split('\n').entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const type = String(parsed.type ?? '');
      const { timestamp, timestampLabel } = parseEntryTimestamp(parsed.timestamp, fallbackTimestamp);
      const payload = safeObject(parsed.payload);

      if (type === 'thread.started') {
        threadId = String(parsed.thread_id ?? '') || threadId;
        continue;
      }

      if (type === 'turn.started') {
        entries.push({
          id: `${run.id}:turn-start:${entries.length}`,
          kind: 'event',
          label: 'Run started',
          text: run.mode === 'launch' ? 'Owned Codex run launched from o8.' : 'Owned Codex session resumed from o8.',
          timestamp,
          timestampLabel,
        });
        continue;
      }

      if (type === 'event_msg' && payload?.type === 'agent_message') {
        const text = compactText(
          typeof payload.message === 'string' ? payload.message : extractStructuredText(payload.content),
          500,
        );
        if (text) {
          entries.push({
            id: `${run.id}:event-message:${lineIndex}`,
            kind: 'message',
            label: payload.phase === 'commentary' ? 'Progress' : 'Assistant',
            text,
            timestamp,
            timestampLabel,
          });
        }
        continue;
      }

      if (type === 'event_msg' && payload?.type === 'task_complete') {
        completedTurn = true;
        entries.push({
          id: `${run.id}:task-complete:${lineIndex}`,
          kind: 'event',
          label: 'Task completed',
          text: 'Run completed.',
          timestamp,
          timestampLabel,
        });
        continue;
      }

      if (type === 'event_msg' && payload?.type === 'exec_command_begin') {
        const command = readStringField(payload, 'parsed_cmd', 'cmd', 'command');
        entries.push({
          id: `${run.id}:exec-begin:${lineIndex}`,
          kind: 'tool',
          label: 'exec_command',
          text: command ? `Run ${compactText(command, 180)}` : 'Run shell command',
          timestamp,
          timestampLabel,
        });
        continue;
      }

      if (type === 'event_msg' && payload?.type === 'exec_command_end') {
        const output = toolOutputPreview(payload.aggregated_output ?? payload.output);
        if (output) {
          entries.push({
            id: `${run.id}:exec-output:${lineIndex}`,
            kind: 'tool-output',
            label: 'Tool output',
            text: output,
            timestamp,
            timestampLabel,
          });
        }
        continue;
      }

      if (type === 'response_item' && (payload?.type === 'function_call' || payload?.type === 'custom_tool_call')) {
        const toolName = readStringField(payload, 'name', 'namespace', 'execution') ?? 'tool';
        const toolInput = payload.type === 'custom_tool_call' ? payload.input : payload.arguments;
        entries.push({
          id: `${run.id}:tool-call:${readStringField(payload, 'call_id', 'id') ?? lineIndex}`,
          kind: 'tool',
          label: toolName,
          text: describeToolActivity(toolName, toolInput),
          timestamp,
          timestampLabel,
        });
        continue;
      }

      if (type === 'response_item' && (payload?.type === 'function_call_output' || payload?.type === 'custom_tool_call_output')) {
        const output = toolOutputPreview(payload.output);
        if (output) {
          entries.push({
            id: `${run.id}:tool-output:${readStringField(payload, 'call_id', 'id') ?? lineIndex}`,
            kind: 'tool-output',
            label: 'Tool output',
            text: output,
            timestamp,
            timestampLabel,
          });
        }
        continue;
      }

      if (type === 'item.completed') {
        const item = safeObject(parsed.item);
        if (!item) {
          continue;
        }

        if (item.type === 'agent_message') {
          const text = compactText(
            readStringField(item, 'text')
              ?? extractStructuredText(item.content)
              ?? extractStructuredText(item.message),
            // Completion receipts live at the end of the final assistant
            // message. A presentation-sized preview here permanently removed
            // the closing self-review block before lifecycle code could parse
            // it, even though the durable JSONL contained the full receipt.
            20_000,
          );
          if (text) {
            entries.push({
              id: `${run.id}:message:${entries.length}`,
              kind: 'message',
              label: 'Assistant',
              text,
              timestamp,
              timestampLabel,
            });
          }
          continue;
        }

        if (item.type === 'tool_use') {
          const toolName = readStringField(item, 'name', 'tool_name') ?? 'tool';
          const toolInput = item.input ?? item.arguments ?? item.invocation ?? item;
          entries.push({
            id: `${run.id}:tool-use:${readStringField(item, 'id') ?? lineIndex}`,
            kind: 'tool',
            label: toolName,
            text: describeToolActivity(toolName, toolInput),
            timestamp,
            timestampLabel,
          });
          continue;
        }

        if (item.type === 'command_execution') {
          const command = String(item.command ?? '').trim();
          const output = toolOutputPreview(item.aggregated_output);

          entries.push({
            id: `${run.id}:tool:${readStringField(item, 'id') ?? lineIndex}`,
            kind: 'tool',
            label: 'exec_command',
            text: command ? `Run ${compactText(command, 180)}` : 'Run shell command',
            timestamp,
            timestampLabel,
          });

          if (output) {
            entries.push({
              id: `${run.id}:tool-output:${readStringField(item, 'id') ?? lineIndex}`,
              kind: 'tool-output',
              label: 'Tool output',
              text: output,
              timestamp,
              timestampLabel,
            });
          }
          continue;
        }
      }

      if (type === 'item.started') {
        const item = safeObject(parsed.item);
        if (item?.type === 'command_execution') {
          const command = String(item.command ?? '').trim();
          entries.push({
            id: `${run.id}:tool-start:${readStringField(item, 'id') ?? lineIndex}`,
            kind: 'tool',
            label: 'exec_command',
            text: command ? `Running ${compactText(command, 180)}` : 'Running shell command',
            timestamp,
            timestampLabel,
          });
          continue;
        }
        if (item?.type === 'tool_use') {
          const toolName = readStringField(item, 'name', 'tool_name') ?? 'tool';
          const toolInput = item.input ?? item.arguments ?? item.invocation ?? item;
          entries.push({
            id: `${run.id}:tool-start:${readStringField(item, 'id') ?? lineIndex}`,
            kind: 'tool',
            label: toolName,
            text: describeToolActivity(toolName, toolInput),
            timestamp,
            timestampLabel,
          });
          continue;
        }
      }

      if (type === 'turn.completed') {
        completedTurn = true;
        const usage = (parsed.usage ?? {}) as Record<string, unknown>;
        const usageBits = [
          usage.input_tokens ? `${usage.input_tokens} in` : null,
          usage.cached_input_tokens ? `${usage.cached_input_tokens} cached` : null,
          usage.output_tokens ? `${usage.output_tokens} out` : null,
        ].filter(Boolean);
        entries.push({
          id: `${run.id}:turn-complete:${entries.length}`,
          kind: 'event',
          label: 'Turn completed',
          text: usageBits.length ? `Usage • ${usageBits.join(' • ')}` : 'Run completed.',
          timestamp,
          timestampLabel,
        });
        continue;
      }
    } catch {
      entries.push({
        id: `${run.id}:noise:${noiseIndex += 1}`,
        kind: 'event',
        label: 'Runtime',
        text: compactText(trimmed, 500),
        timestamp: run.finishedAt ?? run.startedAt,
        timestampLabel: formatClock(run.finishedAt ?? run.startedAt),
      });
    }
  }

  const outcome = run.outcome === 'running'
    ? completedTurn
      ? 'finished'
      : run.interruptRequestedAt
        ? 'interrupted'
        : 'running'
    : run.outcome;

  return {
    threadId,
    entries,
    outcome,
    completedTurn,
  };
}

// ── Codex run-evidence parser (for review packets) ──────────────────────────

function codexParseRunEvidence(raw: string, run: OwnedRunRecord, resolvedOutcome: OwnedRunOutcome): OwnedRunEvidence {
  let assistantSummary: string | undefined;
  const commands = [] as RuntimeReviewCommandEvidence[];
  const finalOutcome = resolvedOutcome ?? run.outcome;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;

    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (parsed.type !== 'item.started' && parsed.type !== 'item.completed') {
        continue;
      }

      const item = (parsed.item ?? {}) as Record<string, unknown>;
      if (item.type === 'agent_message' && parsed.type === 'item.completed') {
        assistantSummary = previewText(String(item.text ?? ''), 220) ?? assistantSummary;
        continue;
      }

      if (item.type !== 'command_execution') {
        continue;
      }

      const itemId = String(item.id ?? `${run.id}:${commands.length}`);
      const current = commands.find((entry) => entry.id === itemId);
      const baseStatus = parsed.type === 'item.started' ? 'running' : 'completed';
      const exitCode = item.exit_code == null ? null : Number(item.exit_code);
      const nextStatus = finalOutcome === 'interrupted'
        ? 'interrupted'
        : parsed.type === 'item.completed' && exitCode && exitCode !== 0
          ? 'failed'
          : finalOutcome === 'failed' && parsed.type !== 'item.completed'
            ? 'failed'
            : baseStatus;
      const nextEntry: RuntimeReviewCommandEvidence = {
        id: itemId,
        command: previewText(String(item.command ?? ''), 180) ?? 'command',
        status: nextStatus,
        exitCode,
        outputPreview: previewText(String(item.aggregated_output ?? ''), 260),
      };

      if (current) {
        Object.assign(current, nextEntry);
      } else {
        commands.push(nextEntry);
      }
    } catch {
      continue;
    }
  }

  if (finalOutcome !== 'running') {
    for (const command of commands) {
      if (command.status !== 'running') continue;
      command.status = finalOutcome === 'finished'
        ? 'completed'
        : finalOutcome === 'interrupted'
          ? 'interrupted'
          : 'failed';
    }
  }

  return {
    assistantSummary,
    commands,
  };
}

// ── Adapter wiring + store ───────────────────────────────────────────────────

/** Patterns in Codex stderr that are non-fatal noise (MCP server teardown, etc.) */
const CODEX_STDERR_NOISE_PATTERNS: RegExp[] = [
  /rmcp::transport::worker.*worker quit/i,
  /mcp.*connection refused/i,
  /mcp.*transport channel closed/i,
];

const codexAdapter: OwnedRuntimeAdapter = {
  runtimeId: 'codex',
  // IMPORTANT: Keep 'codex-owned:' prefix — load-bearing for session routing.
  surfaceIdPrefix: 'codex-owned:',
  rootEnvVar: 'CORTEX_IDE_OWNED_CODEX_ROOT',
  rootDefault: path.join(getDataDir(), 'owned-codex'),
  binaryName: 'codex',
  binaryEnvOverride: 'O8_CODEX_BIN',
  isolatedConfigHomeEnv: 'CODEX_HOME',
  defaultConfigHome: () => process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex'),
  humanLabel: 'Owned Codex',
  squadShortName: 'Codex',
  sessionIdPrefix: 'codex-owned-',
  launchArgs: codexLaunchArgs,
  resumeArgs: codexResumeArgs,
  parseRunLog: codexParseRunLog,
  parseRunEvidence: codexParseRunEvidence,
  stderrNoise: CODEX_STDERR_NOISE_PATTERNS,
  retryDelayMs: 5_000,
  launchGroupLabel: 'Launch turn',
  resumeGroupLabel: 'Resume turn',
};

const codexStore = createOwnedSessionStore(codexAdapter);

// ── Public API (identical signatures to the pre-Wave-2b implementation) ─────

export function invalidateOwnedCodexFleetCache(): void {
  codexStore.invalidateFleetCache();
}

export async function archiveOwnedCodexSession(surfaceId: string) {
  return codexStore.archiveSession(surfaceId);
}

export async function ownedCodexSessionState(surfaceId: string) {
  return codexStore.sessionState(surfaceId);
}

export async function sweepOrphanedCodexSessions(activeSurfaceIds: Set<string>, maxAgeMs: number) {
  return codexStore.sweepOrphanedSessions(activeSurfaceIds, maxAgeMs);
}

export async function launchOwnedCodexSession(
  request: OwnedCodexLaunchRequest,
): Promise<OwnedCodexLaunchResponse> {
  const result = await codexStore.launch(request);
  return {
    ok: result.ok,
    runtime: 'codex',
    surfaceId: result.surfaceId,
    note: result.note,
  };
}

export async function continueOwnedCodexSession(surfaceId: string, prompt: string) {
  return codexStore.resume(surfaceId, prompt);
}

export async function interruptOwnedCodexSession(surfaceId: string) {
  return codexStore.interrupt(surfaceId);
}

export async function setOwnedCodexReviewDisposition(
  surfaceId: string,
  disposition: OwnedReviewDisposition,
) {
  return codexStore.setReviewDisposition(surfaceId, disposition);
}

export async function getOwnedCodexTelemetrySources(surfaceId: string) {
  return codexStore.getTelemetrySources(surfaceId);
}

export async function getOwnedCodexSessionIdentityId(surfaceId: string) {
  return codexStore.getSessionIdentityId(surfaceId);
}

export async function getOwnedCodexRuntimeTail(surfaceId: string, limit?: number) {
  return codexStore.getRuntimeTail(surfaceId, limit);
}

export async function getOwnedCodexReviewPacket(surfaceId: string) {
  return codexStore.getReviewPacket(surfaceId);
}

export async function getOwnedCodexFleetAdditions(
  options: { fresh?: boolean } = {},
) {
  return codexStore.getFleetAdditions(options);
}
