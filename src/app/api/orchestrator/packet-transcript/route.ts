import { access, open, readdir, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NextResponse, type NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { getCodexRolloutPath } from '@/lib/codex/sessions';
import { getOwnedCodexTelemetrySources } from '@/lib/codex/owned';
import { getOwnedOpencodeTelemetrySources } from '@/lib/opencode/owned';
import { getOwnedGeminiTelemetrySources } from '@/lib/gemini/owned';
import { listLanes } from '@/lib/lane/registry';
import { readOrchestratorControlPlaneState } from '@/lib/orchestrator/control-plane';
import { normalizeCodexEvents, type TranscriptEvent } from '@/lib/orchestrator/transcript-normalizer';
import {
  normalizeClaudeCodeEvents,
  normalizeOpencodeEvents,
} from '@/lib/orchestrator/transcript-normalizer-multi';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_TAIL_BYTES = 256_000;

function parseLimit(raw: string | null): number {
  if (!raw) return DEFAULT_LIMIT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.floor(parsed));
}

function parseCursor(raw: string | null): number {
  if (!raw) return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

function parseTail(raw: string | null): boolean {
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
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
 * #846 — Lane-registry fallback for the binding race.
 *
 * When a packet completes fast (small dispatches finish before mission
 * state catches up), `packet.lane` may be null in the control-plane state
 * by the time MCP reads it back, even though the lane registry already has
 * the sessionKey recorded. Look it up by packetId across ALL lanes
 * (including completed/archived) so the transcript stays reachable.
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

/**
 * Resolved JSONL bundle: the raw text plus the runtime tag we use to pick a
 * normalizer. `runtime: null` means we couldn't read anything for this key.
 */
type ResolvedJsonl = {
  raw: string;
  runtime: 'codex' | 'opencode' | 'claude-code' | 'gemini' | null;
  /** When set, the route should return a structured error instead of events. */
  unsupportedReason?: string;
};

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

/**
 * Find a claude-code session JSONL by walking ~/.claude/projects/<encoded>/
 * looking for `<sessionId>.jsonl`. Mirrors `findSessionJsonl` from the
 * claude-code adapter — kept inline so this route doesn't have to depend
 * on the adapter's private helpers.
 */
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
      // not in this project
    }
  }
  return null;
}

async function resolveRawJsonlForSession(sessionKey: string): Promise<ResolvedJsonl> {
  if (!sessionKey) return { raw: '', runtime: null };

  // ── Codex owned ──────────────────────────────────────────────────────────
  if (sessionKey.startsWith('codex-owned:')) {
    try {
      const sources = await getOwnedCodexTelemetrySources(sessionKey);
      if (!sources) return { raw: '', runtime: 'codex' };
      return { raw: await readOwnedRunStdouts(sources.stdoutPaths), runtime: 'codex' };
    } catch {
      return { raw: '', runtime: 'codex' };
    }
  }

  // ── Codex discovered (rollout file in ~/.codex/sessions) ─────────────────
  if (sessionKey.startsWith('codex:') || sessionKey.startsWith('codex-discovered:')) {
    try {
      const rolloutPath = await getCodexRolloutPath(sessionKey);
      if (!rolloutPath) return { raw: '', runtime: 'codex' };
      return { raw: await readRawTail(rolloutPath), runtime: 'codex' };
    } catch {
      return { raw: '', runtime: 'codex' };
    }
  }

  // ── opencode owned ───────────────────────────────────────────────────────
  if (sessionKey.startsWith('opencode-owned:')) {
    try {
      const sources = await getOwnedOpencodeTelemetrySources(sessionKey);
      if (!sources) return { raw: '', runtime: 'opencode' };
      return { raw: await readOwnedRunStdouts(sources.stdoutPaths), runtime: 'opencode' };
    } catch {
      return { raw: '', runtime: 'opencode' };
    }
  }

  // ── claude-code (orchestrator-spawned and discovered both use the same
  // ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl path) ──────────────
  if (sessionKey.startsWith('claude-code:')) {
    try {
      const sessionId = sessionKey.replace('claude-code:', '');
      // Synthetic live-PID keys never have a JSONL yet.
      if (sessionId.startsWith('live-')) return { raw: '', runtime: 'claude-code' };
      const jsonlPath = await findClaudeCodeJsonl(sessionId);
      if (!jsonlPath) return { raw: '', runtime: 'claude-code' };
      return { raw: await readRawTail(jsonlPath), runtime: 'claude-code' };
    } catch {
      return { raw: '', runtime: 'claude-code' };
    }
  }

  // ── gemini owned (mirrors opencode-owned via the shared owned-session
  // store — `getTelemetrySources` returns `stdoutPaths` to concatenate) ────
  if (sessionKey.startsWith('gemini-owned:')) {
    try {
      const sources = await getOwnedGeminiTelemetrySources(sessionKey);
      if (!sources) return { raw: '', runtime: 'gemini' };
      // Gemini's CLI JSONL output schema doesn't have a public-stable
      // normalizer yet — gemini.ts only consumes it for owned-session tail
      // entries, not the codex-style TranscriptEvent shape this route
      // emits. Surface a structured error so callers see the gap instead
      // of empty events.
      return {
        raw: '',
        runtime: 'gemini',
        unsupportedReason: 'gemini-transcript-not-supported-yet',
      };
    } catch {
      return {
        raw: '',
        runtime: 'gemini',
        unsupportedReason: 'gemini-transcript-not-supported-yet',
      };
    }
  }

  // ── plain `gemini:` (discovered, no canonical store) ─────────────────────
  if (sessionKey.startsWith('gemini:') || sessionKey.startsWith('gemini-discovered:')) {
    return {
      raw: '',
      runtime: 'gemini',
      unsupportedReason: 'gemini-transcript-not-supported-yet',
    };
  }

  // Live/unknown — no durable transcript.
  return { raw: '', runtime: null };
}

/**
 * Pick the right JSONL→TranscriptEvent normalizer for a runtime tag.
 */
function normalizeForRuntime(runtime: ResolvedJsonl['runtime'], raw: string): TranscriptEvent[] {
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

export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const params = request.nextUrl.searchParams;
  const packetId = (params.get('packetId') ?? '').trim();
  const limit = parseLimit(params.get('limit'));
  const cursor = parseCursor(params.get('cursor'));
  const tail = parseTail(params.get('tail'));

  if (!packetId) {
    return NextResponse.json(
      { ok: false, error: { code: 'packet_id_required', message: 'packetId is required' } },
      { status: 400, headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  }

  try {
    const packet = findPacket(packetId);
    // #846 — Fall back to the lane registry when the mission-state binding
    // got stripped (fast-completing packets race the control-plane writer).
    // The lane registry retains `packetId → sessionKey` even after the lane
    // archives, so the transcript remains reachable.
    const packetSessionKey = packet?.lane?.sessionKey?.trim() ?? '';
    const sessionKey = packetSessionKey || resolveSessionKeyFromLaneRegistry(packetId);

    if (!packet && !sessionKey) {
      return NextResponse.json(
        { events: [], nextCursor: null, note: 'packet_not_found' },
        { headers: { 'Cache-Control': 'no-store, max-age=0' } },
      );
    }

    if (!sessionKey) {
      return NextResponse.json(
        { events: [], nextCursor: null, note: 'no_session_binding' },
        { headers: { 'Cache-Control': 'no-store, max-age=0' } },
      );
    }

    const resolved = await resolveRawJsonlForSession(sessionKey);
    if (resolved.unsupportedReason) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: resolved.unsupportedReason,
            message: `Transcript readback for ${resolved.runtime ?? 'unknown'} sessions is not implemented yet.`,
          },
          packetId,
          sessionKey,
          runtime: resolved.runtime,
        },
        { status: 501, headers: { 'Cache-Control': 'no-store, max-age=0' } },
      );
    }
    const events = normalizeForRuntime(resolved.runtime, resolved.raw);

    let windowed: TranscriptEvent[];
    if (tail) {
      windowed = events.slice(-limit);
    } else {
      const afterCursor = events.filter((event) => event.seq > cursor);
      windowed = afterCursor.slice(0, limit);
    }

    const nextCursor = windowed.length > 0
      ? windowed[windowed.length - 1].seq
      : null;

    return NextResponse.json(
      {
        packetId,
        sessionKey,
        events: windowed,
        nextCursor,
      },
      { headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to read packet transcript.';
    console.error(`[packet-transcript] read failed: ${message}`);
    return NextResponse.json(
      {
        ok: false,
        error: { code: 'packet_transcript_failed', message },
      },
      { status: 500, headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  }
}
