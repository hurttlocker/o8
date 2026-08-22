import { access, open, readdir, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getCodexRolloutPath } from '@/lib/codex/sessions';
import { getOwnedCodexTelemetrySources } from '@/lib/codex/owned';
import { getOwnedClaudeCodeTelemetrySources } from '@/lib/claude-code/owned';
import { getOwnedGeminiTelemetrySources } from '@/lib/gemini/owned';
import { getLaneEvents, listLanes } from '@/lib/lane/registry';
import { getOwnedOpencodeTelemetrySources } from '@/lib/opencode/owned';
import { readOrchestratorControlPlaneState } from '@/lib/orchestrator/control-plane';
import { normalizeCodexEvents, type TranscriptEvent } from '@/lib/orchestrator/transcript-normalizer';
import {
  normalizeClaudeCodeEvents,
  normalizeOpencodeEvents,
} from '@/lib/orchestrator/transcript-normalizer-multi';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const MAX_TAIL_BYTES = 256_000;

type TranscriptRuntime = 'codex' | 'opencode' | 'claude-code' | 'gemini' | null;

interface ResolvedJsonl {
  raw: string;
  runtime: TranscriptRuntime;
  fallbackTimestamp?: string;
  unsupportedReason?: string;
}

interface RawTailSnapshot {
  raw: string;
  modifiedAt?: string;
}

export interface SessionTranscriptReadback {
  sessionKey: string;
  runtime: TranscriptRuntime;
  events: TranscriptEvent[];
  unsupportedReason?: string;
}

export interface PacketTranscriptReadback extends SessionTranscriptReadback {
  packetId: string;
  note?: string;
}

type LaneSteerTranscriptEvent = Extract<TranscriptEvent, { type: 'steer' }>;
type LaneHuddleTranscriptEvent = Extract<TranscriptEvent, { type: 'assistant' }>;

function findPacket(packetId: string): OrchestratorPacket | null {
  try {
    const mission = readOrchestratorControlPlaneState();
    return mission.packets.find((packet) => packet.id === packetId) ?? null;
  } catch {
    return null;
  }
}

/**
 * Lane-registry fallback for fast-completing packets whose control-plane lane
 * binding may lag behind the durable lane row.
 */
function resolveSessionKeyFromLaneRegistry(packetId: string): string | null {
  try {
    const lane = listLanes().find((candidate) => candidate.packetId === packetId);
    return lane?.sessionKey?.trim() || null;
  } catch {
    return null;
  }
}

async function readRawTailSnapshot(filePath: string, maxBytes = MAX_TAIL_BYTES): Promise<RawTailSnapshot> {
  try {
    const resolved = await realpath(filePath);
    const handle = await open(resolved, 'r');
    try {
      const stat = await handle.stat();
      const bytesToRead = Math.min(stat.size, maxBytes);
      if (bytesToRead <= 0) return { raw: '', modifiedAt: stat.mtime.toISOString() };
      const buffer = Buffer.alloc(bytesToRead);
      await handle.read(buffer, 0, bytesToRead, stat.size - bytesToRead);
      return { raw: buffer.toString('utf8'), modifiedAt: stat.mtime.toISOString() };
    } finally {
      await handle.close();
    }
  } catch {
    return { raw: '' };
  }
}

async function readRawTail(filePath: string, maxBytes = MAX_TAIL_BYTES): Promise<string> {
  return (await readRawTailSnapshot(filePath, maxBytes)).raw;
}

async function readOwnedRunStdouts(stdoutPaths: string[]): Promise<RawTailSnapshot> {
  const chunks: string[] = [];
  let budget = MAX_TAIL_BYTES;
  let modifiedAt: string | undefined;
  for (const stdoutPath of [...stdoutPaths].reverse()) {
    if (budget <= 0) break;
    const snapshot = await readRawTailSnapshot(stdoutPath, budget);
    if (!modifiedAt && snapshot.modifiedAt) modifiedAt = snapshot.modifiedAt;
    if (snapshot.raw) {
      chunks.unshift(snapshot.raw);
      budget -= Buffer.byteLength(snapshot.raw, 'utf8');
    }
  }
  return { raw: chunks.join('\n'), modifiedAt };
}

async function findClaudeCodeJsonl(sessionId: string): Promise<string | null> {
  const claudeHome = process.env.CLAUDE_HOME || path.join(os.homedir(), '.claude');
  const projectsDir = path.join(claudeHome, 'projects');
  let dirs: string[] = [];
  try {
    dirs = await readdir(projectsDir);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const candidate = path.join(projectsDir, dir, `${sessionId}.jsonl`);
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue searching other encoded project directories.
    }
  }
  return null;
}

async function resolveRawJsonlForSession(sessionKey: string): Promise<ResolvedJsonl> {
  if (!sessionKey) return { raw: '', runtime: null };

  if (sessionKey.startsWith('codex-owned:')) {
    try {
      const sources = await getOwnedCodexTelemetrySources(sessionKey);
      if (!sources) return { raw: '', runtime: 'codex' };
      const tail = await readOwnedRunStdouts(sources.stdoutPaths);
      return { raw: tail.raw, runtime: 'codex', fallbackTimestamp: tail.modifiedAt };
    } catch {
      return { raw: '', runtime: 'codex' };
    }
  }

  if (sessionKey.startsWith('codex:') || sessionKey.startsWith('codex-discovered:')) {
    try {
      const rolloutPath = await getCodexRolloutPath(sessionKey);
      if (!rolloutPath) return { raw: '', runtime: 'codex' };
      return { raw: await readRawTail(rolloutPath), runtime: 'codex' };
    } catch {
      return { raw: '', runtime: 'codex' };
    }
  }

  if (sessionKey.startsWith('opencode-owned:')) {
    try {
      const sources = await getOwnedOpencodeTelemetrySources(sessionKey);
      if (!sources) return { raw: '', runtime: 'opencode' };
      return { raw: (await readOwnedRunStdouts(sources.stdoutPaths)).raw, runtime: 'opencode' };
    } catch {
      return { raw: '', runtime: 'opencode' };
    }
  }

  if (sessionKey.startsWith('claude-code-owned:')) {
    try {
      const sources = await getOwnedClaudeCodeTelemetrySources(sessionKey);
      if (!sources) return { raw: '', runtime: 'claude-code' };
      return { raw: (await readOwnedRunStdouts(sources.stdoutPaths)).raw, runtime: 'claude-code' };
    } catch {
      return { raw: '', runtime: 'claude-code' };
    }
  }

  if (sessionKey.startsWith('claude-code:')) {
    try {
      const sessionId = sessionKey.replace('claude-code:', '');
      if (sessionId.startsWith('live-')) return { raw: '', runtime: 'claude-code' };
      const jsonlPath = await findClaudeCodeJsonl(sessionId);
      if (!jsonlPath) return { raw: '', runtime: 'claude-code' };
      return { raw: await readRawTail(jsonlPath), runtime: 'claude-code' };
    } catch {
      return { raw: '', runtime: 'claude-code' };
    }
  }

  if (sessionKey.startsWith('gemini-owned:')) {
    try {
      await getOwnedGeminiTelemetrySources(sessionKey);
    } catch {
      // Same unsupported response either way.
    }
    return {
      raw: '',
      runtime: 'gemini',
      unsupportedReason: 'gemini-transcript-not-supported-yet',
    };
  }

  if (sessionKey.startsWith('gemini:') || sessionKey.startsWith('gemini-discovered:')) {
    return {
      raw: '',
      runtime: 'gemini',
      unsupportedReason: 'gemini-transcript-not-supported-yet',
    };
  }

  return { raw: '', runtime: null };
}

function normalizeForRuntime(
  runtime: TranscriptRuntime,
  raw: string,
  fallbackTimestamp?: string,
): TranscriptEvent[] {
  if (!raw) return [];
  switch (runtime) {
    case 'codex':
      return normalizeCodexEvents(raw, fallbackTimestamp);
    case 'opencode':
      return normalizeOpencodeEvents(raw);
    case 'claude-code':
      return normalizeClaudeCodeEvents(raw);
    default:
      return [];
  }
}

function readTextPayload(payload: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function laneSteerEvents(laneId: string): LaneSteerTranscriptEvent[] {
  return getLaneEvents(laneId, 500)
    .filter((event) => event.verb === 'steered_packet' || event.verb === 'steer_failed')
    .map((event, index) => {
      const source = readTextPayload(event.payload, 'source', 'actor') || event.actor || 'orchestrator';
      const text = readTextPayload(event.payload, 'message', 'text');
      const noteText = readTextPayload(event.payload, 'note', 'error');
      const stderrHead = readTextPayload(event.payload, 'stderrHead');
      const note = [noteText, stderrHead].filter(Boolean).join('\n');
      return {
        seq: index + 1,
        ts: event.timestamp,
        type: 'steer',
        source,
        text: text || note || 'Steer requested.',
        failed: event.verb === 'steer_failed',
        ...(note ? { note } : {}),
      };
    });
}

function laneHuddleEvents(laneId: string): LaneHuddleTranscriptEvent[] {
  return getLaneEvents(laneId, 500)
    .filter((event) => event.verb === 'agent_report' && event.payload.event === 'huddle')
    .map((event, index) => {
      const message = readTextPayload(event.payload, 'message') || 'Huddle plan posted.';
      return {
        seq: index + 1,
        ts: event.timestamp,
        type: 'assistant',
        text: message,
      };
    });
}

function laneSteerEventsForSession(sessionKey: string): LaneSteerTranscriptEvent[] {
  if (!sessionKey) return [];
  const lane = listLanes().find((candidate) => candidate.sessionKey === sessionKey);
  return lane ? laneSteerEvents(lane.id) : [];
}

function laneHuddleEventsForSession(sessionKey: string): LaneHuddleTranscriptEvent[] {
  if (!sessionKey) return [];
  const lane = listLanes().find((candidate) => candidate.sessionKey === sessionKey);
  return lane ? laneHuddleEvents(lane.id) : [];
}

function mergeTranscriptEvents(runtimeEvents: TranscriptEvent[], extraEvents: TranscriptEvent[]): TranscriptEvent[] {
  if (extraEvents.length === 0) return runtimeEvents;
  const stamped = [...runtimeEvents, ...extraEvents]
    .map((event, index) => ({ event, index }))
    .sort((left, right) => {
      const leftMs = new Date(left.event.ts).getTime();
      const rightMs = new Date(right.event.ts).getTime();
      const leftSafe = Number.isFinite(leftMs) ? leftMs : 0;
      const rightSafe = Number.isFinite(rightMs) ? rightMs : 0;
      return leftSafe - rightSafe || left.index - right.index;
    });
  return stamped.map(({ event }, index) => ({ ...event, seq: index + 1 }) as TranscriptEvent);
}

export function readSessionSteerTranscriptEvents(sessionKey: string): LaneSteerTranscriptEvent[] {
  return laneSteerEventsForSession(sessionKey);
}

export function readSessionHuddleTranscriptEvents(sessionKey: string): LaneHuddleTranscriptEvent[] {
  return laneHuddleEventsForSession(sessionKey);
}

export async function readSessionTranscriptEvents(sessionKey: string): Promise<SessionTranscriptReadback> {
  const resolved = await resolveRawJsonlForSession(sessionKey);
  if (resolved.unsupportedReason) {
    return {
      sessionKey,
      runtime: resolved.runtime,
      events: [],
      unsupportedReason: resolved.unsupportedReason,
    };
  }

  return {
    sessionKey,
    runtime: resolved.runtime,
    events: mergeTranscriptEvents(
      normalizeForRuntime(resolved.runtime, resolved.raw, resolved.fallbackTimestamp),
      [...laneHuddleEventsForSession(sessionKey), ...laneSteerEventsForSession(sessionKey)],
    ),
  };
}

export async function readPacketTranscriptEvents(packetId: string): Promise<PacketTranscriptReadback> {
  const packet = findPacket(packetId);
  const packetSessionKey = packet?.lane?.sessionKey?.trim() ?? '';
  const sessionKey = packetSessionKey || resolveSessionKeyFromLaneRegistry(packetId);

  if (!packet && !sessionKey) {
    return { packetId, sessionKey: '', runtime: null, events: [], note: 'packet_not_found' };
  }

  if (!sessionKey) {
    return { packetId, sessionKey: '', runtime: null, events: [], note: 'no_session_binding' };
  }

  const readback = await readSessionTranscriptEvents(sessionKey);
  const packetLane = listLanes().find((lane) => lane.packetId === packetId);
  const packetEvents = packetLane && packetLane.sessionKey !== sessionKey
    ? [...laneHuddleEvents(packetLane.id), ...laneSteerEvents(packetLane.id)]
    : [];
  return {
    packetId,
    ...readback,
    events: mergeTranscriptEvents(readback.events, packetEvents),
  };
}

export function latestTranscriptEventAt(events: TranscriptEvent[]): string | null {
  let latestMs = 0;
  let latestIso: string | null = null;

  for (const event of events) {
    const parsed = new Date(event.ts).getTime();
    if (!Number.isFinite(parsed) || parsed <= latestMs) continue;
    latestMs = parsed;
    latestIso = new Date(parsed).toISOString();
  }

  return latestIso;
}
