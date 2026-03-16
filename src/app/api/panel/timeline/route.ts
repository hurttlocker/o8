import { NextResponse } from 'next/server';

/**
 * /api/panel/timeline — Aggregates today's agent activity into timeline segments.
 *
 * Phase 1: Reads gateway sessions, maps message patterns to segment kinds.
 * Returns segments array for the SessionTimeline component.
 *
 * Segment classification:
 * - tool calls (exec/read/write/edit) → coding
 * - thinking blocks, planning → thinking
 * - test/verify mentions → testing
 * - errors → error
 * - gaps > 5min → idle
 */

const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789';
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || '';

interface GatewaySession {
  sessionId: string;
  agentId: string;
  label?: string;
  createdAt?: string;
  lastMessageAt?: string;
  messageCount?: number;
}

interface TimelineSegment {
  kind: 'thinking' | 'coding' | 'testing' | 'error' | 'idle';
  startMin: number;
  durationMin: number;
  label?: string;
  agent?: string;
  sessionId?: string;
}

// Classify a message into a segment kind
function classifyMessage(msg: any): 'thinking' | 'coding' | 'testing' | 'error' | 'idle' {
  const role = msg.role || '';
  const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || '');
  const toolName = msg.name || msg.tool_name || '';

  // Errors
  if (role === 'error' || content.includes('Error:') || content.includes('error:') || content.includes('FAILED')) {
    return 'error';
  }

  // Tool calls = coding
  if (role === 'tool' || toolName || content.includes('tool_calls') || content.includes('exec') || content.includes('function_call')) {
    // Check if it's a test-related tool call
    if (content.includes('test') || content.includes('verify') || content.includes('tsc --noEmit') || content.includes('npm test')) {
      return 'testing';
    }
    return 'coding';
  }

  // Assistant thinking
  if (role === 'assistant') {
    if (content.includes('thinking') || content.includes('planning') || content.includes('Let me') || content.length < 200) {
      return 'thinking';
    }
    return 'coding';
  }

  return 'thinking';
}

export async function GET() {
  try {
    // Get today's start time (9 AM ET)
    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(9, 0, 0, 0);

    if (now < todayStart) {
      return NextResponse.json({ segments: [], totalMinutes: 0, agentCount: 0 });
    }

    // Fetch sessions from gateway
    const sessionsRes = await fetch(`${GATEWAY_URL}/api/sessions?active=true`, {
      headers: {
        'Authorization': `Bearer ${GATEWAY_TOKEN}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(5000),
    });

    if (!sessionsRes.ok) {
      return NextResponse.json({ segments: [], error: 'gateway_unavailable' }, { status: 502 });
    }

    const sessionsData = await sessionsRes.json();
    const sessions: GatewaySession[] = Array.isArray(sessionsData) ? sessionsData : (sessionsData.sessions || []);

    // Filter to today's sessions
    const todaySessions = sessions.filter((s) => {
      const lastMsg = s.lastMessageAt ? new Date(s.lastMessageAt) : null;
      const created = s.createdAt ? new Date(s.createdAt) : null;
      const relevant = lastMsg || created;
      return relevant && relevant >= todayStart;
    });

    if (todaySessions.length === 0) {
      return NextResponse.json({ segments: [], totalMinutes: 0, agentCount: 0 });
    }

    // For each session, try to get recent history and classify
    const allSegments: TimelineSegment[] = [];

    for (const session of todaySessions.slice(0, 10)) { // Cap at 10 sessions
      try {
        const histRes = await fetch(
          `${GATEWAY_URL}/api/sessions/${session.sessionId}/history?limit=50`,
          {
            headers: {
              'Authorization': `Bearer ${GATEWAY_TOKEN}`,
              'Content-Type': 'application/json',
            },
            signal: AbortSignal.timeout(3000),
          }
        );

        if (!histRes.ok) continue;

        const histData = await histRes.json();
        const messages = Array.isArray(histData) ? histData : (histData.messages || []);

        if (messages.length === 0) continue;

        // Group messages into time blocks (5-min granularity)
        let currentKind: string | null = null;
        let blockStart = 0;
        let blockDur = 0;

        for (const msg of messages) {
          const ts = msg.timestamp || msg.created_at;
          if (!ts) continue;

          const msgTime = new Date(ts);
          if (msgTime < todayStart) continue;

          const minSinceStart = Math.floor((msgTime.getTime() - todayStart.getTime()) / 60000);
          const kind = classifyMessage(msg);

          if (currentKind === null) {
            currentKind = kind;
            blockStart = minSinceStart;
            blockDur = 1;
          } else if (kind === currentKind && minSinceStart - (blockStart + blockDur) < 5) {
            // Same kind, extend block
            blockDur = minSinceStart - blockStart + 1;
          } else {
            // Different kind or gap — flush current block
            if (minSinceStart - (blockStart + blockDur) >= 5) {
              // Insert idle gap
              allSegments.push({
                kind: currentKind as any,
                startMin: blockStart,
                durationMin: blockDur,
                agent: session.agentId,
                sessionId: session.sessionId,
              });
              allSegments.push({
                kind: 'idle',
                startMin: blockStart + blockDur,
                durationMin: minSinceStart - (blockStart + blockDur),
                agent: session.agentId,
              });
            } else {
              allSegments.push({
                kind: currentKind as any,
                startMin: blockStart,
                durationMin: blockDur,
                agent: session.agentId,
                sessionId: session.sessionId,
              });
            }
            currentKind = kind;
            blockStart = minSinceStart;
            blockDur = 1;
          }
        }

        // Flush last block
        if (currentKind !== null) {
          allSegments.push({
            kind: currentKind as any,
            startMin: blockStart,
            durationMin: blockDur,
            agent: session.agentId,
            sessionId: session.sessionId,
          });
        }
      } catch {
        // Skip failed session history fetch
      }
    }

    // Sort by start time and merge adjacent same-kind segments
    allSegments.sort((a, b) => a.startMin - b.startMin);

    const merged: TimelineSegment[] = [];
    for (const seg of allSegments) {
      const last = merged[merged.length - 1];
      if (last && last.kind === seg.kind && seg.startMin <= last.startMin + last.durationMin + 2) {
        // Merge overlapping/adjacent same-kind
        last.durationMin = Math.max(last.durationMin, (seg.startMin + seg.durationMin) - last.startMin);
      } else {
        merged.push({ ...seg });
      }
    }

    const totalMinutes = merged.length > 0
      ? merged[merged.length - 1].startMin + merged[merged.length - 1].durationMin
      : 0;

    return NextResponse.json({
      segments: merged,
      totalMinutes,
      agentCount: new Set(todaySessions.map(s => s.agentId)).size,
      sessionCount: todaySessions.length,
    });
  } catch (err) {
    return NextResponse.json({ segments: [], error: 'internal' }, { status: 500 });
  }
}
