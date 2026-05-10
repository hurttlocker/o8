import { access, open, readdir, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getCodexRolloutPath } from '@/lib/codex/sessions';
import { getOwnedCodexTelemetrySources } from '@/lib/codex/owned';
import { getOwnedGeminiTelemetrySources } from '@/lib/gemini/owned';
import { listLanes } from '@/lib/lane/registry';
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
  unsupportedReason?: string;
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

async function readRawTail(filePath: string, maxBytes = MAX_TAIL_BYTES): Promise<string> {
  try {
    const resolved = await realpath(filePath);
    const handle = await open(resolved, 'r');
    try {
      const stat = await handle.stat();
      const bytesToRead = Math.min(stat.size, maxBytes);
      if (bytesToRead <= 0) return '';
      const buffer = Buffer.alloc(bytesToRead);
      await handle.read(buffer, 0, bytesToRead, stat.size - bytesToRead);
      return buffer.toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return '';
  }
}

async function readOwnedRunStdouts(stdoutPaths: string[]): Promise<string> {
  const chunks: string[] = [];
  let budget = MAX_TAIL_BYTES;
  for (const stdoutPath of stdoutPaths) {
    if (budget <= 0) break;
    const chunk = await readRawTail(stdoutPath, budget);
    if (chunk) {
      chunks.push(chunk);
      budget -= Buffer.byteLength(chunk, 'utf8');
    }
  }
  return chunks.join('\n');
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
      return { raw: await readOwnedRunStdouts(sources.stdoutPaths), runtime: 'codex' };
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
      return { raw: await readOwnedRunStdouts(sources.stdoutPaths), runtime: 'opencode' };
    } catch {
      return { raw: '', runtime: 'opencode' };
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

function normalizeForRuntime(runtime: TranscriptRuntime, raw: string): TranscriptEvent[] {
  if (!raw) return [];
  switch (runtime) {
    case 'codex':
      return normalizeCodexEvents(raw);
    case 'opencode':
      return normalizeOpencodeEvents(raw);
    case 'claude-code':
      return normalizeClaudeCodeEvents(raw);
    default:
      return [];
  }
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
    events: normalizeForRuntime(resolved.runtime, resolved.raw),
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
  return { packetId, ...readback };
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
