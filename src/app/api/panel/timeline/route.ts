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
    // Only mark as error if it's a REAL failure (exit code non-zero at the end, or explicit error patterns)
    const isRealError = (lc.includes('exit: 1') || lc.includes('permission denied') || lc.includes('command failed') || lc.includes('fatal:'))
      && !lc.includes('exit: 0') && !lc.includes('successfully');
    if (isRealError) {
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
    // Use a rolling 24h window anchored to 6 AM. Before 6 AM, show yesterday's activity.
    const todayStart = new Date(now);
    if (now.getHours() < 6) {
      // Before 6 AM — anchor to yesterday 6 AM
      todayStart.setDate(todayStart.getDate() - 1);
    }
    todayStart.setHours(6, 0, 0, 0);

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

      // Read last 500 lines for full day coverage
      const lines = execQuiet(`tail -500 "${file}" 2>/dev/null`, { timeout: 10000 });
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

    // Pass 1: Merge adjacent same-kind segments (within 3 min gap)
    const pass1: TimelineSegment[] = [];
    for (const seg of allSegments) {
      const last = pass1[pass1.length - 1];
      if (last && last.kind === seg.kind && seg.startMin <= last.startMin + last.durationMin + 3) {
        last.durationMin = Math.max(last.durationMin, (seg.startMin + seg.durationMin) - last.startMin);
      } else {
        pass1.push({ ...seg });
      }
    }

    // Pass 2: Absorb short segments (< 3 min) into their neighbors.
    // In a real coding session, thinking→coding→thinking→coding rapidly
    // alternating should just be "coding". The dominant kind wins.
    const merged: TimelineSegment[] = [];
    for (let i = 0; i < pass1.length; i++) {
      const seg = pass1[i];
      const prev = merged[merged.length - 1];

      // If this segment is tiny and adjacent to something, absorb it.
      // Coding always wins over thinking (tool calls happen between planning messages).
      if (seg.durationMin <= 2 && seg.kind !== 'idle' && seg.kind !== 'error') {
        if (prev && prev.kind !== 'idle' && seg.startMin <= prev.startMin + prev.durationMin + 3) {
          // Extend previous to cover this, but upgrade to coding if either is coding
          if (seg.kind === 'coding' || prev.kind === 'coding') {
            prev.kind = 'coding';
          }
          prev.durationMin = Math.max(prev.durationMin, (seg.startMin + seg.durationMin) - prev.startMin);
          continue;
        }
      }

      // Try to merge with previous
      if (prev && prev.kind === seg.kind && seg.startMin <= prev.startMin + prev.durationMin + 3) {
        prev.durationMin = Math.max(prev.durationMin, (seg.startMin + seg.durationMin) - prev.startMin);
      } else {
        merged.push({ ...seg });
      }
    }

    // Pass 3: Final merge — any remaining non-idle segments within 5 min get merged.
    // The LONGER segment's kind wins (coding sessions absorb brief thinking pauses).
    // Errors stay separate (they're important signals) unless truly tiny (< 2 min).
    const final: TimelineSegment[] = [];
    for (const seg of merged) {
      const prev = final[final.length - 1];
      if (
        prev &&
        seg.kind !== 'idle' && prev.kind !== 'idle' &&
        seg.kind !== 'error' && prev.kind !== 'error' &&
        seg.startMin <= prev.startMin + prev.durationMin + 5
      ) {
        // Coding wins when merging (coding sessions have thinking interspersed)
        if (seg.kind === 'coding' || prev.kind === 'coding') {
          prev.kind = 'coding';
        } else if (seg.durationMin > prev.durationMin) {
          prev.kind = seg.kind;
        }
        prev.durationMin = Math.max(prev.durationMin, (seg.startMin + seg.durationMin) - prev.startMin);
      } else {
        final.push({ ...seg });
      }
    }

    const totalMinutes = final.length > 0
      ? final[final.length - 1].startMin + final[final.length - 1].durationMin
      : 0;

    // Summary stats
    const kindTotals: Record<string, number> = {};
    for (const seg of final) {
      kindTotals[seg.kind] = (kindTotals[seg.kind] || 0) + seg.durationMin;
    }

    return NextResponse.json({
      segments: final,
      totalMinutes,
      stats: kindTotals,
      source: 'jsonl',
    });
  } catch {
    return NextResponse.json({ segments: [], error: 'internal' }, { status: 500 });
  }
}
