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
  state: { label: 'State', color: '#ef4444' },          // red — largest cluster
  kv: { label: 'Key-Value', color: '#f59e0b' },         // amber
  relationship: { label: 'Relationships', color: '#3b82f6' }, // blue
  temporal: { label: 'Temporal', color: '#06b6d4' },     // cyan
  decision: { label: 'Decisions', color: '#8b5cf6' },    // purple
  identity: { label: 'Identity', color: '#ec4899' },     // pink
  config: { label: 'Config', color: '#22c55e' },         // green
  preference: { label: 'Preferences', color: '#f97316' },// orange
  location: { label: 'Locations', color: '#14b8a6' },    // teal
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
    const totalFacts = stats.facts ?? 0;
    const totalMemories = stats.memories ?? 0;
    const confidenceDist = stats.confidence_distribution ?? {};

    // Build clusters from type breakdown
    const clusters: ClusterData[] = [];
    for (const [type, count] of Object.entries(factsByType)) {
      const meta = TYPE_MAP[type] ?? { label: type, color: '#94a3b8' };
      clusters.push({
        label: meta.label,
        type,
        factCount: count,
        avgConfidence: stats.avg_confidence ? stats.avg_confidence * 100 : 80,
        color: meta.color,
        facts: [], // populated on search
      });
    }

    // Sort by fact count (biggest clusters first)
    clusters.sort((a, b) => b.factCount - a.factCount);

    // If search query, fetch matching facts
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
        totalFacts,
        totalMemories,
        sources: stats.sources ?? 0,
        avgConfidence: stats.avg_confidence ? (stats.avg_confidence * 100).toFixed(1) : '0',
        confidenceHigh: confidenceDist.high ?? 0,
        confidenceMedium: confidenceDist.medium ?? 0,
        confidenceLow: confidenceDist.low ?? 0,
      },
    });
  } catch (err) {
    return NextResponse.json({
      clusters: [],
      searchResults: [],
      stats: { totalFacts: 0, totalMemories: 0, sources: 0, avgConfidence: '0' },
      error: err instanceof Error ? err.message : 'Unknown error',
    });
  }
}
