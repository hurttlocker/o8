export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { execSync } from 'child_process';

const CORTEX_BIN = process.env.HOME ? `${process.env.HOME}/bin/cortex` : '/usr/local/bin/cortex';

interface ClusterData {
  label: string;
  type: string;
  factCount: number;
  avgConfidence: number;
  color: string;
  facts: { text: string; confidence: number; source: string }[];
}

// Map cortex fact types to display labels + colors
const TYPE_MAP: Record<string, { label: string; color: string }> = {
  state: { label: 'State', color: '#ef4444' },
  kv: { label: 'Key-Value', color: '#f59e0b' },
  relationship: { label: 'Relationships', color: '#3b82f6' },
  temporal: { label: 'Temporal', color: '#06b6d4' },
  decision: { label: 'Decisions', color: '#8b5cf6' },
  identity: { label: 'Identity', color: '#ec4899' },
  config: { label: 'Config', color: '#22c55e' },
  preference: { label: 'Preferences', color: '#f97316' },
  location: { label: 'Locations', color: '#14b8a6' },
};

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q') || '';

  try {
    // Get stats with type breakdown
    const statsOutput = execSync(`${CORTEX_BIN} stats 2>/dev/null`, {
      encoding: 'utf-8', timeout: 5000,
    });
    const stats = JSON.parse(statsOutput);
    const factsByType: Record<string, number> = stats.facts_by_type ?? {};
    const totalMemories = stats.memories ?? 0;

    // Get REAL active/retired/superseded counts from beliefs
    let activeFacts = 0;
    let retiredFacts = 0;
    let supersededFacts = 0;
    let totalFacts = 0;
    try {
      const beliefsOutput = execSync(`${CORTEX_BIN} beliefs 2>/dev/null`, {
        encoding: 'utf-8', timeout: 5000,
      });
      const beliefs = JSON.parse(beliefsOutput);
      const states = beliefs.states ?? {};
      activeFacts = states.active ?? 0;
      retiredFacts = states.retired ?? 0;
      supersededFacts = states.superseded ?? 0;
      totalFacts = beliefs.total ?? (activeFacts + retiredFacts + supersededFacts);
    } catch {
      // Fallback to stats if beliefs unavailable
      totalFacts = stats.facts ?? 0;
      activeFacts = stats.confidence_distribution?.high ?? totalFacts;
    }

    // Scale cluster fact counts proportionally to active-only
    // stats.facts_by_type includes ALL facts (active + retired + superseded)
    // We want to show the active proportion for each type
    const totalInTypes = Object.values(factsByType).reduce((s: number, c) => s + (c as number), 0);
    const activeRatio = totalInTypes > 0 ? activeFacts / totalInTypes : 1;

    // Build clusters from type breakdown
    const clusters: ClusterData[] = [];
    for (const [type, rawCount] of Object.entries(factsByType)) {
      const meta = TYPE_MAP[type] ?? { label: type, color: '#94a3b8' };
      // Approximate active count per type (proportional scaling)
      const activeCount = Math.round((rawCount as number) * activeRatio);
      clusters.push({
        label: meta.label,
        type,
        factCount: activeCount,
        avgConfidence: stats.avg_confidence ? stats.avg_confidence * 100 : 80,
        color: meta.color,
        facts: [],
      });
    }

    clusters.sort((a, b) => b.factCount - a.factCount);

    // Search
    let searchResults: { text: string; confidence: number; source: string; type: string }[] = [];
    if (query) {
      try {
        const searchOutput = execSync(
          `${CORTEX_BIN} search "${query.replace(/"/g, '\\"')}" 50 2>/dev/null`,
          { encoding: 'utf-8', timeout: 8000 },
        );
        const results = JSON.parse(searchOutput);
        if (Array.isArray(results)) {
          searchResults = results.map((r: Record<string, unknown>) => ({
            text: ((r.snippet as string) || '').slice(0, 140),
            confidence: typeof r.score === 'number' ? r.score * 100 : 50,
            source: (r.source_section as string) || (r.source_file as string)?.split('/').pop() || 'cortex',
            type: (r.fact_type as string) || 'unknown',
          }));
        }
      } catch { /* search failed */ }
    }

    return NextResponse.json({
      clusters,
      searchResults,
      stats: {
        activeFacts,
        retiredFacts,
        supersededFacts,
        totalFacts,
        totalMemories,
        sources: stats.sources ?? 0,
        avgConfidence: stats.avg_confidence ? (stats.avg_confidence * 100).toFixed(1) : '0',
      },
    });
  } catch (err) {
    return NextResponse.json({
      clusters: [],
      searchResults: [],
      stats: { activeFacts: 0, retiredFacts: 0, supersededFacts: 0, totalFacts: 0, totalMemories: 0, sources: 0, avgConfidence: '0' },
      error: err instanceof Error ? err.message : 'Unknown error',
    });
  }
}
