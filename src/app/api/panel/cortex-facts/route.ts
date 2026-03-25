export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { cortexRecall, getCortexClient } from '@/lib/cortex/client';

interface CortexFact {
  text: string;
  confidence: number;
  source: string;
  category: string;
}

// More queries = more particles. Each query pulls different facts.
const QUERIES = [
  // People
  { q: 'Q Marquise person name', cat: 'People' },
  { q: 'SB Sydney family wedding', cat: 'People' },
  { q: 'agent fleet members', cat: 'People' },
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
  { label: 'People', color: '#3b82f6' },
  { label: 'Decisions', color: '#f59e0b' },
  { label: 'Code', color: '#22c55e' },
  { label: 'Projects', color: '#ef4444' },
  { label: 'Config', color: '#8b5cf6' },
  { label: 'Identity', color: '#ec4899' },
  { label: 'Learned', color: '#06b6d4' },
  { label: 'Tasks', color: '#f97316' },
];

export async function GET() {
  try {
    const client = getCortexClient();

    // Quick availability check — don't hang for 2+ min if cortex binary missing
    const available = await client.isAvailable().catch(() => false);
    if (!available) {
      return NextResponse.json({ facts: [], categories: CATEGORIES });
    }

    const facts: CortexFact[] = [];
    const seenFactIds = new Set<number>();

    // Run queries in parallel with 3s timeout per query
    const results = await Promise.allSettled(
      QUERIES.map(async ({ q, cat }) => {
        try {
          const recall = await cortexRecall(q, { limit: 8 });
          return { items: recall.items, cat };
        } catch {
          return { items: [], cat };
        }
      })
    );

    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      const { items, cat } = result.value;
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        if (!item.text || item.text.length < 10) continue;
        if (seenFactIds.has(item.factId)) continue;
        seenFactIds.add(item.factId);
        const primaryEvidence = item.evidence[0];
        const sourcePath = primaryEvidence?.sourceFile || item.sourceTier;
        const confidence = Math.round(Math.max(item.relevance, item.confidence, item.qualityScore) * 100);
        facts.push({
          text: item.text.length > 140 ? item.text.slice(0, 137) + '…' : item.text,
          confidence,
          source: sourcePath || 'cortex',
          category: cat,
        });
      }
    }

    // Get stats via client
    let totalFacts = 0;
    let activeFacts = 0;
    let totalMemories = 0;
    try {
      const stats = await client.stats();
      if (stats) {
        totalFacts = stats.facts ?? 0;
        totalMemories = stats.memories ?? 0;
        activeFacts = stats.confidence_distribution?.high ?? totalFacts;
      }
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
