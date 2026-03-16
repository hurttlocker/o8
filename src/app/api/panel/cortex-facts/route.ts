export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { execSync } from 'child_process';

const CORTEX_BIN = process.env.HOME ? `${process.env.HOME}/bin/cortex` : '/usr/local/bin/cortex';

interface CortexFact {
  text: string;
  confidence: number;
  source: string;
  category: string;
}

interface CortexResult {
  content?: string;
  snippet?: string;
  score?: number;
  source_file?: string;
  source_section?: string;
}

// More queries = more particles. Each query pulls different facts.
const QUERIES = [
  // People
  { q: 'Q Marquise person name', cat: 'People' },
  { q: 'SB Sydney family wedding', cat: 'People' },
  { q: 'agent Mister Niot Hawk', cat: 'People' },
  { q: 'who user human owner', cat: 'People' },
  // Decisions
  { q: 'decided decision chose preference', cat: 'Decisions' },
  { q: 'chose picked selected option approach', cat: 'Decisions' },
  { q: 'strategy plan direction architecture', cat: 'Decisions' },
  { q: 'will should must priority', cat: 'Decisions' },
  // Code
  { q: 'function component typescript react', cat: 'Code' },
  { q: 'api endpoint route handler server', cat: 'Code' },
  { q: 'commit push deploy build compile', cat: 'Code' },
  { q: 'bug fix error crash issue', cat: 'Code' },
  { q: 'import module package dependency', cat: 'Code' },
  // Projects
  { q: 'cortex ide dashboard tauri', cat: 'Projects' },
  { q: 'spear production workflow', cat: 'Projects' },
  { q: 'trading options QQQ SPY market', cat: 'Projects' },
  { q: 'openclaw gateway agent runtime', cat: 'Projects' },
  { q: 'eyes web antiflammi health', cat: 'Projects' },
  // Config
  { q: 'config key token secret env', cat: 'Config' },
  { q: 'api key password credential auth', cat: 'Config' },
  { q: 'port url domain hostname', cat: 'Config' },
  { q: 'model claude opus sonnet haiku', cat: 'Config' },
  // Identity
  { q: 'personality soul identity voice tone', cat: 'Identity' },
  { q: 'style brand design glass frost', cat: 'Identity' },
  { q: 'rule principle philosophy approach', cat: 'Identity' },
  // Learned
  { q: 'learned lesson mistake correction', cat: 'Learned' },
  { q: 'pattern avoid remember important', cat: 'Learned' },
  { q: 'discovered found realized insight', cat: 'Learned' },
  { q: 'warning caution never always', cat: 'Learned' },
  // Tasks
  { q: 'task todo next priority upcoming', cat: 'Tasks' },
  { q: 'schedule cron heartbeat timer', cat: 'Tasks' },
  { q: 'blocked waiting pending deferred', cat: 'Tasks' },
];

const CATEGORIES = [
  { label: 'People', color: '#3b82f6' },       // blue
  { label: 'Decisions', color: '#f59e0b' },     // amber
  { label: 'Code', color: '#22c55e' },          // green
  { label: 'Projects', color: '#ef4444' },      // red
  { label: 'Config', color: '#8b5cf6' },        // purple
  { label: 'Identity', color: '#ec4899' },      // pink
  { label: 'Learned', color: '#06b6d4' },       // cyan
  { label: 'Tasks', color: '#f97316' },         // orange
];

export async function GET() {
  try {
    const facts: CortexFact[] = [];
    const seen = new Set<string>();

    for (const { q, cat } of QUERIES) {
      try {
        const output = execSync(
          `${CORTEX_BIN} search "${q}" 30 2>/dev/null`,
          { encoding: 'utf-8', timeout: 5000 },
        );

        let results: CortexResult[] = [];
        try { results = JSON.parse(output); } catch { continue; }
        if (!Array.isArray(results)) continue;

        for (const r of results) {
          const snippet = r.snippet || '';
          if (!snippet || snippet.length < 10) continue;

          // Use first 50 chars as dedup key (catches similar facts)
          const cleanText = snippet.replace(/^[#\s*-]+/, '').trim();
          const key = cleanText.slice(0, 50).toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);

          const confidence = typeof r.score === 'number'
            ? Math.min(r.score * 100, 100)
            : 50;

          facts.push({
            text: cleanText.length > 140 ? cleanText.slice(0, 137) + '…' : cleanText,
            confidence,
            source: r.source_section || r.source_file?.split('/').pop() || 'cortex',
            category: cat,
          });
        }
      } catch { /* skip failed query */ }
    }

    // Get stats
    let totalFacts = 0;
    let activeFacts = 0;
    let totalMemories = 0;
    try {
      const statsOutput = execSync(`${CORTEX_BIN} stats 2>/dev/null`, {
        encoding: 'utf-8', timeout: 3000,
      });
      const s = JSON.parse(statsOutput);
      totalFacts = s.facts ?? 0;
      totalMemories = s.memories ?? 0;
      activeFacts = s.confidence_distribution?.high ?? totalFacts;
    } catch { /* silent */ }

    return NextResponse.json({
      facts,
      categories: CATEGORIES,
      stats: { totalFacts, activeFacts, totalMemories },
    });
  } catch (err) {
    return NextResponse.json({
      facts: [],
      categories: CATEGORIES,
      stats: { totalFacts: 0, activeFacts: 0, totalMemories: 0 },
      error: err instanceof Error ? err.message : 'Unknown error',
    });
  }
}
