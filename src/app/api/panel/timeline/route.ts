import { NextResponse } from 'next/server';
import { execSync } from 'child_process';

/**
 * /api/panel/timeline — Aggregates today's agent activity into timeline segments.
 *
 * Reads JSONL session files directly. OpenClaw JSONL format:
 * { type, id, parentId, timestamp, message: { role, content, tool_calls, name } }
 *
 * Roles: assistant, user, toolResult (tool output = coding activity)
 */

interface TimelineSegment {
  kind: 'thinking' | 'coding' | 'testing' | 'error' | 'idle';
  startMin: number;
  durationMin: number;
  label?: string;
  agent?: string;
}

function execQuiet(cmd: string, opts?: { timeout?: number }): string {
  try {
    return execSync(cmd, {
      encoding: 'utf-8',
      timeout: opts?.timeout ?? 8000,
      maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, PATH: `${process.env.PATH}:/usr/local/bin:/opt/homebrew/bin` },
    }).trim();
  } catch {
    return '';
  }
}

function classifyMessage(role: string, content: string, type: string): 'thinking' | 'coding' | 'testing' | 'error' | 'idle' {
  const lc = content.toLowerCase();

  // Tool results are direct evidence of coding activity
  if (role === 'toolResult' || role === 'tool') {
    // Check for errors in tool output
    if (lc.includes('error:') || lc.includes('exit: 1') || lc.includes('permission denied') || lc.includes('command failed')) {
      return 'error';
    }
    // Check for testing patterns
    if (lc.includes('tsc --noemit') || lc.includes('npm test') || lc.includes('npm run test') || lc.includes('jest') || lc.includes('vitest')) {
      return 'testing';
    }
    // All other tool results = coding
    return 'coding';
  }

  // Assistant messages with tool calls = coding
  if (role === 'assistant') {
    // Look for coding indicators in the message
    if (lc.includes('commit') || lc.includes('shipped') || lc.includes('pushed') || lc.includes('git push') ||
        lc.includes('let me fix') || lc.includes('let me build') || lc.includes('let me add') || lc.includes('let me create') ||
        lc.includes('let me rewrite') || lc.includes('let me update') || lc.includes('now wire') || lc.includes('now add') ||
        lc.includes('successfully replaced') || lc.includes('successfully wrote') || lc.includes('i need to check') ||
        lc.includes('the fix is') || lc.includes('two fixes') || lc.includes('three things')) {
      return 'coding';
    }
    // Short assistant messages between tool calls = still coding (narration)
    if (content.length < 150) return 'coding';
    // Longer messages = thinking/planning
    return 'thinking';
  }

  // User messages = thinking (giving direction)
  if (role === 'user') return 'thinking';

  // Compaction / custom events
  if (type === 'compaction') return 'idle';

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

    // Find today's session files across all agents
    const lsRaw = execQuiet(`ls -t ~/.openclaw/agents/*/sessions/*.jsonl 2>/dev/null | head -15`);
    const files = lsRaw.split('\n').filter(Boolean);

    if (files.length === 0) {
      return NextResponse.json({ segments: [], totalMinutes: 0, source: 'none' });
    }

    const allSegments: TimelineSegment[] = [];

    for (const file of files) {
      const agentMatch = file.match(/agents\/([^/]+)\//);
      const agent = agentMatch ? agentMatch[1] : 'unknown';

      // Read last 200 lines for better coverage
      const lines = execQuiet(`tail -200 "${file}" 2>/dev/null`);
      if (!lines) continue;

      let currentKind: string | null = null;
      let blockStart = 0;
      let blockDur = 0;
      let hasToday = false;

      for (const line of lines.split('\n')) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          const ts = entry.timestamp;
          if (!ts) continue;

          const msgTime = new Date(ts);
          if (isNaN(msgTime.getTime()) || msgTime < todayStart) continue;
          hasToday = true;

          const minSinceStart = Math.floor((msgTime.getTime() - todayStart.getTime()) / 60000);
          const inner = entry.message || {};
          const role = inner.role || '';
          const type = entry.type || '';
          const content = typeof inner.content === 'string'
            ? inner.content
            : Array.isArray(inner.content)
              ? inner.content.map((c: any) => (typeof c === 'string' ? c : c?.text || '')).join(' ')
              : '';

          const kind = classifyMessage(role, content, type);

          if (currentKind === null) {
            currentKind = kind;
            blockStart = minSinceStart;
            blockDur = 1;
          } else if (kind === currentKind && minSinceStart - (blockStart + blockDur) < 3) {
            // Same kind and within 3 min — extend block
            blockDur = Math.max(blockDur, minSinceStart - blockStart + 1);
          } else {
            // Different kind or gap
            const gapMin = minSinceStart - (blockStart + blockDur);
            allSegments.push({ kind: currentKind as any, startMin: blockStart, durationMin: Math.max(blockDur, 1), agent });
            if (gapMin >= 5) {
              allSegments.push({ kind: 'idle', startMin: blockStart + blockDur, durationMin: gapMin, agent });
            }
            currentKind = kind;
            blockStart = minSinceStart;
            blockDur = 1;
          }
        } catch { continue; }
      }

      // Flush last block
      if (currentKind !== null && hasToday) {
        allSegments.push({ kind: currentKind as any, startMin: blockStart, durationMin: Math.max(blockDur, 1), agent });
      }
    }

    // Sort by start time
    allSegments.sort((a, b) => a.startMin - b.startMin);

    // Merge adjacent same-kind segments (within 2 min gap)
    const merged: TimelineSegment[] = [];
    for (const seg of allSegments) {
      const last = merged[merged.length - 1];
      if (last && last.kind === seg.kind && seg.startMin <= last.startMin + last.durationMin + 2) {
        last.durationMin = Math.max(last.durationMin, (seg.startMin + seg.durationMin) - last.startMin);
      } else {
        merged.push({ ...seg });
      }
    }

    const totalMinutes = merged.length > 0
      ? merged[merged.length - 1].startMin + merged[merged.length - 1].durationMin
      : 0;

    // Summary stats
    const kindTotals: Record<string, number> = {};
    for (const seg of merged) {
      kindTotals[seg.kind] = (kindTotals[seg.kind] || 0) + seg.durationMin;
    }

    return NextResponse.json({
      segments: merged,
      totalMinutes,
      stats: kindTotals,
      source: 'jsonl',
    });
  } catch {
    return NextResponse.json({ segments: [], error: 'internal' }, { status: 500 });
  }
}
