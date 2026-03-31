import { getCortexClient } from '@/lib/cortex/client';
import type { AgentSummary } from '@/lib/fleet/types';
import type { PacketContext } from '@/lib/orchestrator/types';
import { getRuntimeInventorySnapshot } from '@/lib/runtime/inventory';
import { getRuntime } from '@/lib/runtimes/registry';
import type { RuntimeId, RuntimeTranscriptEntry } from '@/lib/runtimes/types';

const PACKET_CONTEXT_SOURCE_PREFIX = 'orchestrator-packet-context';
const PACKET_CONTEXT_JSON_START = '<context-pass-json>';
const PACKET_CONTEXT_JSON_END = '</context-pass-json>';
const PACKET_CONTEXT_SEARCH_LIMIT = 8;
const TRANSCRIPT_CAPTURE_LIMIT = 80;
const SUMMARY_LIMIT = 1_200;
const NOTE_LIMIT = 320;
const NOTE_PATTERN = /\b(blocker|blocked|blocking|note|notes|remaining|next step|todo|unable|could not|can't|cannot|failed|failure|error|waiting)\b/i;

function inferRuntimeId(sessionKey: string): RuntimeId | null {
  if (sessionKey.startsWith('claude-code:')) {
    return 'claude-code';
  }
  if (sessionKey.startsWith('codex')) {
    return 'codex';
  }
  return null;
}

function truncateText(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function normalizeSummaryText(text: string, max: number): string {
  const withoutCode = text.replace(/```[\s\S]*?```/g, '[code omitted]');
  const normalized = withoutCode
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');

  return truncateText(normalized, max);
}

function pushUniqueSection(target: string[], value?: string) {
  const normalized = value?.trim();
  if (!normalized || target.includes(normalized)) {
    return;
  }
  target.push(normalized);
}

function findLastAssistantEntry(entries: RuntimeTranscriptEntry[]): RuntimeTranscriptEntry | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.role !== 'assistant' || !entry.text.trim()) {
      continue;
    }
    return entry;
  }
  return null;
}

function findRecentNote(entries: RuntimeTranscriptEntry[], excludedEntryId?: string | null): string {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.id === excludedEntryId) {
      continue;
    }
    if (entry.role !== 'assistant' && entry.role !== 'system') {
      continue;
    }
    const text = entry.text.trim();
    if (!text || !NOTE_PATTERN.test(text)) {
      continue;
    }
    return normalizeSummaryText(text, NOTE_LIMIT);
  }
  return '';
}

function latestTranscriptTimestamp(entries: RuntimeTranscriptEntry[]): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const timestamp = entries[index]?.timestamp;
    if (!(timestamp instanceof Date) || Number.isNaN(timestamp.getTime())) {
      continue;
    }
    return timestamp.toISOString();
  }
  return null;
}

function buildChangedFileList(entries: RuntimeTranscriptEntry[], runtimeChangedFiles: Array<{ path: string }>): string[] {
  const seen = new Set<string>();
  const files: string[] = [];
  const transcriptFiles = entries
    .map((entry) => entry.filePath)
    .filter((value): value is string => Boolean(value?.trim()));

  for (const filePath of runtimeChangedFiles.map((file) => file.path).concat(transcriptFiles)) {
    const normalized = filePath.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    files.push(normalized);
  }

  return files.sort((left, right) => left.localeCompare(right));
}

function buildPacketSummary(input: {
  lifecycleSummary?: string;
  assistantSummary?: string;
  note?: string;
  changedFiles: string[];
}): string {
  const sections: string[] = [];
  pushUniqueSection(sections, input.lifecycleSummary);
  pushUniqueSection(sections, input.assistantSummary);

  if (sections.length === 0) {
    if (input.changedFiles.length > 0) {
      sections.push(`Updated ${input.changedFiles.length} file${input.changedFiles.length === 1 ? '' : 's'} during the completed run.`);
    } else {
      sections.push('Completed the run without a recoverable assistant summary.');
    }
  }

  if (input.note) {
    pushUniqueSection(sections, `Notes: ${input.note}`);
  }

  return sections.join('\n\n');
}

function serializePacketContext(context: PacketContext): string {
  const changedFiles = context.changedFiles.length > 0
    ? context.changedFiles.map((filePath) => `- ${filePath}`).join('\n')
    : '- none';

  return [
    'Orchestrator dependency handoff memory.',
    `packet-id: ${context.packetId}`,
    `session-key: ${context.sessionKey}`,
    `completed-at: ${context.completedAt}`,
    `model: ${context.model}`,
    '',
    'Summary:',
    context.summary,
    '',
    'Files changed:',
    changedFiles,
    '',
    PACKET_CONTEXT_JSON_START,
    JSON.stringify(context, null, 2),
    PACKET_CONTEXT_JSON_END,
  ].join('\n');
}

function isPacketContext(value: unknown): value is PacketContext {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return typeof candidate.packetId === 'string'
    && typeof candidate.sessionKey === 'string'
    && typeof candidate.summary === 'string'
    && Array.isArray(candidate.changedFiles)
    && candidate.changedFiles.every((entry) => typeof entry === 'string')
    && typeof candidate.completedAt === 'string'
    && typeof candidate.model === 'string';
}

function parsePacketContext(content: string): PacketContext | null {
  const match = content.match(
    new RegExp(`${PACKET_CONTEXT_JSON_START}\\s*([\\s\\S]*?)\\s*${PACKET_CONTEXT_JSON_END}`),
  );
  if (!match?.[1]) {
    return null;
  }

  try {
    const parsed = JSON.parse(match[1]) as unknown;
    return isPacketContext(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function findAgentSummary(sessionKey: string): Promise<AgentSummary | null> {
  const snapshot = await getRuntimeInventorySnapshot({ fresh: true });
  return snapshot.agents.find((agent) => agent.sessionKey === sessionKey) ?? null;
}

async function storePacketContext(context: PacketContext): Promise<void> {
  const client = getCortexClient();
  if (!(await client.isAvailable())) {
    console.warn(`[context-pass] Cortex unavailable; skipped packet context store for ${context.packetId}`);
    return;
  }

  const result = await client.store(
    serializePacketContext(context),
    `${PACKET_CONTEXT_SOURCE_PREFIX}-${context.packetId}`,
  );

  if (!result.ok) {
    console.error(`[context-pass] Failed to store packet context for ${context.packetId}`);
    return;
  }

  console.log(`[context-pass] Stored packet context for ${context.packetId}`);
}

export async function readPacketCompletionContext(packetId: string): Promise<PacketContext | null> {
  const normalizedPacketId = packetId.trim();
  if (!normalizedPacketId) {
    return null;
  }

  const client = getCortexClient();
  if (!(await client.isAvailable())) {
    return null;
  }

  const results = await client.search(
    `orchestrator dependency handoff packet-id ${normalizedPacketId}`,
    PACKET_CONTEXT_SEARCH_LIMIT,
  );

  const matches = results
    .map((result) => parsePacketContext(result.content))
    .filter((context): context is PacketContext => context !== null && context.packetId === normalizedPacketId)
    .sort((left, right) => new Date(right.completedAt).getTime() - new Date(left.completedAt).getTime());

  return matches[0] ?? null;
}

export async function capturePacketCompletionContext(packetId: string, sessionKey: string): Promise<PacketContext> {
  const normalizedPacketId = packetId.trim();
  const normalizedSessionKey = sessionKey.trim();
  const runtimeId = inferRuntimeId(normalizedSessionKey);
  const runtime = runtimeId ? getRuntime(runtimeId) : undefined;

  const [transcriptResult, changedFilesResult, agentResult, telemetryResult] = await Promise.allSettled([
    runtime?.readTranscript(normalizedSessionKey, undefined, TRANSCRIPT_CAPTURE_LIMIT) ?? Promise.resolve([]),
    runtime?.getChangedFiles(normalizedSessionKey) ?? Promise.resolve([]),
    findAgentSummary(normalizedSessionKey),
    runtime?.getTelemetry?.(normalizedSessionKey) ?? Promise.resolve(undefined),
  ]);

  const transcript = transcriptResult.status === 'fulfilled' ? transcriptResult.value : [];
  const changedFiles = buildChangedFileList(
    transcript,
    changedFilesResult.status === 'fulfilled' ? changedFilesResult.value : [],
  );
  const agent = agentResult.status === 'fulfilled' ? agentResult.value : null;
  const telemetry = telemetryResult.status === 'fulfilled' ? telemetryResult.value : undefined;
  const lastAssistantEntry = findLastAssistantEntry(transcript);
  const context: PacketContext = {
    packetId: normalizedPacketId,
    sessionKey: normalizedSessionKey,
    summary: buildPacketSummary({
      lifecycleSummary: normalizeSummaryText(agent?.runtimeSurface?.lifecycle?.summary ?? '', SUMMARY_LIMIT),
      assistantSummary: normalizeSummaryText(lastAssistantEntry?.text ?? '', SUMMARY_LIMIT),
      note: findRecentNote(transcript, lastAssistantEntry?.id ?? null),
      changedFiles,
    }),
    changedFiles,
    completedAt: agent?.runtimeSurface?.lifecycle?.lastRunFinishedAt
      ?? latestTranscriptTimestamp(transcript)
      ?? new Date().toISOString(),
    model: telemetry?.model?.trim()
      || agent?.model?.trim()
      || runtimeId
      || 'unknown',
  };

  await storePacketContext(context);
  return context;
}
