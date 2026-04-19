import { open, realpath } from 'node:fs/promises';
import { NextResponse, type NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { getCodexRolloutPath } from '@/lib/codex/sessions';
import { getOwnedCodexTelemetrySources } from '@/lib/codex/owned';
import { readOrchestratorControlPlaneState } from '@/lib/orchestrator/control-plane';
import { normalizeCodexEvents, type TranscriptEvent } from '@/lib/orchestrator/transcript-normalizer';
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

async function resolveRawJsonlForSession(sessionKey: string): Promise<string> {
  if (!sessionKey) return '';

  // Owned sessions — stdoutPaths from recentRuns (concatenate all runs in order).
  if (sessionKey.startsWith('codex-owned:')) {
    try {
      const sources = await getOwnedCodexTelemetrySources(sessionKey);
      if (!sources) return '';
      const chunks: string[] = [];
      let budget = MAX_TAIL_BYTES;
      for (const stdoutPath of sources.stdoutPaths) {
        if (budget <= 0) break;
        const chunk = await readRawTail(stdoutPath, budget);
        if (chunk) {
          chunks.push(chunk);
          budget -= Buffer.byteLength(chunk, 'utf8');
        }
      }
      return chunks.join('\n');
    } catch {
      return '';
    }
  }

  // Discovered sessions — rollout file in ~/.codex/sessions.
  if (sessionKey.startsWith('codex:') || sessionKey.startsWith('codex-discovered:')) {
    try {
      const rolloutPath = await getCodexRolloutPath(sessionKey);
      if (!rolloutPath) return '';
      return await readRawTail(rolloutPath);
    } catch {
      return '';
    }
  }

  // Live/unknown — no durable transcript.
  return '';
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
    const sessionKey = packet?.lane?.sessionKey?.trim() ?? '';

    if (!packet) {
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

    const rawJsonl = await resolveRawJsonlForSession(sessionKey);
    const events = normalizeCodexEvents(rawJsonl);

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
