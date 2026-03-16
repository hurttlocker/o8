import { NextResponse } from 'next/server';
import { execSync } from 'child_process';

/**
 * /api/panel/timeline — Aggregates today's agent activity into timeline segments.
 *
 * Uses openclaw CLI (same pattern as universal-search) to read session data.
 * Classifies messages into segment kinds for the SessionTimeline component.
 */

interface TimelineSegment {
  kind: 'thinking' | 'coding' | 'testing' | 'error' | 'idle';
  startMin: number;
  durationMin: number;
  label?: string;
  agent?: string;
  sessionId?: string;
}

function execQuiet(cmd: string, opts?: { timeout?: number }): string {
  try {
    return execSync(cmd, {
      encoding: 'utf-8',
      timeout: opts?.timeout ?? 8000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, PATH: `${process.env.PATH}:/usr/local/bin:/opt/homebrew/bin` },
    }).trim();
  } catch {
    return '';
  }
}

function classifyContent(role: string, content: string): 'thinking' | 'coding' | 'testing' | 'error' | 'idle' {
  const lc = content.toLowerCase();

  if (lc.includes('error') || lc.includes('failed') || lc.includes('permission denied') || lc.includes('exit: 1')) {
    return 'error';
  }
  if (role === 'tool' || lc.includes('exec') || lc.includes('write') || lc.includes('edit') || lc.includes('git commit') || lc.includes('git push')) {
    if (lc.includes('tsc --noemit') || lc.includes('npm test') || lc.includes('verify') || lc.includes('check')) {
      return 'testing';
    }
    return 'coding';
  }
  if (role === 'assistant') {
    // Short responses or planning language = thinking
    if (content.length < 300 || lc.includes('let me') || lc.includes('planning') || lc.includes('thinking') || lc.includes('i need to')) {
      return 'thinking';
    }
    return 'coding';
  }
  return 'thinking';
}

export async function GET() {
  try {
    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(9, 0, 0, 0);
    if (now < todayStart) {
      return NextResponse.json({ segments: [], totalMinutes: 0 });
    }

    // Get session list via CLI
    const sessionsRaw = execQuiet('openclaw status --json 2>/dev/null || echo "[]"', { timeout: 10000 });
    let sessions: any[] = [];
    try {
      const parsed = JSON.parse(sessionsRaw);
      sessions = Array.isArray(parsed) ? parsed : (parsed.sessions || parsed.agents || []);
    } catch {
      // Try alternative: read session files directly
      const lsRaw = execQuiet(`ls -t ~/.openclaw/agents/*/sessions/*.jsonl 2>/dev/null | head -10`);
      const files = lsRaw.split('\n').filter(Boolean);

      const allSegments: TimelineSegment[] = [];

      for (const file of files) {
        // Get agent name from path
        const agentMatch = file.match(/agents\/([^/]+)\//);
        const agent = agentMatch ? agentMatch[1] : 'unknown';

        // Read last 100 lines of the session file
        const lines = execQuiet(`tail -100 "${file}" 2>/dev/null`);
        if (!lines) continue;

        let currentKind: string | null = null;
        let blockStart = 0;
        let blockDur = 0;

        for (const line of lines.split('\n')) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            const ts = msg.timestamp || msg.ts || msg.created;
            if (!ts) continue;

            const msgTime = new Date(ts);
            if (isNaN(msgTime.getTime()) || msgTime < todayStart) continue;

            const minSinceStart = Math.floor((msgTime.getTime() - todayStart.getTime()) / 60000);
            const role = msg.role || '';
            const content = typeof msg.content === 'string'
              ? msg.content
              : Array.isArray(msg.content)
                ? msg.content.map((c: any) => c.text || '').join(' ')
                : '';
            const kind = classifyContent(role, content);

            if (currentKind === null) {
              currentKind = kind;
              blockStart = minSinceStart;
              blockDur = 1;
            } else if (kind === currentKind && minSinceStart - (blockStart + blockDur) < 5) {
              blockDur = Math.max(blockDur, minSinceStart - blockStart + 1);
            } else {
              // Flush block
              if (minSinceStart - (blockStart + blockDur) >= 5) {
                allSegments.push({ kind: currentKind as any, startMin: blockStart, durationMin: blockDur, agent });
                allSegments.push({ kind: 'idle', startMin: blockStart + blockDur, durationMin: minSinceStart - (blockStart + blockDur), agent });
              } else {
                allSegments.push({ kind: currentKind as any, startMin: blockStart, durationMin: blockDur, agent });
              }
              currentKind = kind;
              blockStart = minSinceStart;
              blockDur = 1;
            }
          } catch { continue; }
        }

        if (currentKind !== null) {
          allSegments.push({ kind: currentKind as any, startMin: blockStart, durationMin: blockDur, agent });
        }
      }

      // Sort and merge
      allSegments.sort((a, b) => a.startMin - b.startMin);
      const merged: TimelineSegment[] = [];
      for (const seg of allSegments) {
        const last = merged[merged.length - 1];
        if (last && last.kind === seg.kind && seg.startMin <= last.startMin + last.durationMin + 2) {
          last.durationMin = Math.max(last.durationMin, (seg.startMin + seg.durationMin) - last.startMin);
          if (!last.agent && seg.agent) last.agent = seg.agent;
        } else {
          merged.push({ ...seg });
        }
      }

      const totalMinutes = merged.length > 0
        ? merged[merged.length - 1].startMin + merged[merged.length - 1].durationMin
        : 0;

      return NextResponse.json({ segments: merged, totalMinutes, source: 'jsonl' });
    }

    return NextResponse.json({ segments: [], totalMinutes: 0 });
  } catch {
    return NextResponse.json({ segments: [], error: 'internal' }, { status: 500 });
  }
}
