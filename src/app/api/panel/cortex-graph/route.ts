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

function detectFactType(f: Record<string, unknown>): string {
  const pred = String(f.predicate ?? '').toLowerCase();
  const subj = String(f.subject ?? '').toLowerCase();
  const obj = String(f.object ?? '').toLowerCase();
  const all = `${subj} ${pred} ${obj}`;

  if (pred.includes('prefer') || pred.includes('like') || pred.includes('want') || pred.includes('favorite')) return 'preference';
  if (pred.includes('decide') || pred.includes('chose') || pred.includes('select') || pred.includes('decision')) return 'decision';
  if (pred.includes('name') || pred.includes('role') || pred.includes('pronouns') || pred.includes('is a') || pred.includes('identity')) return 'identity';
  if (pred.includes('located') || pred.includes('address') || pred.includes('city') || pred.includes('lives') || all.includes('location')) return 'location';
  if (pred.includes('config') || pred.includes('set to') || pred.includes('port') || pred.includes('path') || pred.includes('version')) return 'config';
  if (pred.includes('knows') || pred.includes('works with') || pred.includes('married') || pred.includes('friend') || pred.includes('co-founder')) return 'relationship';
  if (pred.includes('scheduled') || pred.includes('date') || pred.includes('since') || pred.includes('started') || pred.includes('deadline')) return 'temporal';
  if (pred === '=' || pred === 'is' || pred === 'equals' || pred.includes('value') || pred.includes('key')) return 'kv';
  if (pred.includes('uses') || pred.includes('runs') || pred.includes('has')) return 'state';

  return 'state';
}

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

    // Search — two-pass: memory search for relevance + beliefs for structured facts
    let searchResults: { text: string; confidence: number; source: string; type: string; factId?: number; subject?: string; predicate?: string; object?: string }[] = [];
    if (query) {
      const escapedQuery = query.replace(/"/g, '\\"').replace(/`/g, '\\`').replace(/\$/g, '\\$');

      // Pass 1: Memory search (BM25 + semantic) for relevance-ranked results
      try {
        const searchOutput = execSync(
          `${CORTEX_BIN} search "${escapedQuery}" 30 2>/dev/null`,
          { encoding: 'utf-8', timeout: 8000 },
        );
        const results = JSON.parse(searchOutput);
        if (Array.isArray(results)) {
          // Get fact_ids from memory results to look up structured data
          const factIds = new Set<number>();
          for (const r of results) {
            if (Array.isArray(r.fact_ids)) {
              for (const id of r.fact_ids) factIds.add(id);
            }
          }

          // Pass 2: Get structured facts for those IDs (if any)
          let factMap = new Map<number, Record<string, unknown>>();
          if (factIds.size > 0) {
            try {
              const beliefsOutput = execSync(
                `${CORTEX_BIN} beliefs inspect --json --state active --limit 500 2>/dev/null`,
                { encoding: 'utf-8', timeout: 8000 },
              );
              const beliefs = JSON.parse(beliefsOutput);
              for (const f of (beliefs.facts ?? [])) {
                if (factIds.has(f.fact_id) || true) { // index all for term matching
                  factMap.set(f.fact_id, f);
                }
              }
            } catch { /* beliefs unavailable */ }
          }

          // Also do term matching on facts if memory search returned few results
          if (factMap.size > 0) {
            const qLower = query.toLowerCase();
            const qTerms = qLower.split(/\s+/).filter(t => t.length > 1);
            const termMatched: Record<string, unknown>[] = [];

            for (const [, f] of factMap) {
              const haystack = `${f.subject} ${f.predicate} ${f.object}`.toLowerCase();
              if (qTerms.some(term => haystack.includes(term))) {
                termMatched.push(f);
              }
            }

            // Add term-matched facts as results
            for (const f of termMatched.slice(0, 20)) {
              const type = detectFactType(f);
              searchResults.push({
                text: `${f.subject} → ${f.predicate} → ${f.object}`,
                confidence: typeof f.confidence === 'number' ? f.confidence * 100 : 50,
                source: `${f.source_count ?? 1} sources`,
                type,
                factId: f.fact_id as number,
                subject: String(f.subject ?? ''),
                predicate: String(f.predicate ?? ''),
                object: String(f.object ?? ''),
              });
            }
          }

          // Add memory search results (for broader coverage)
          for (const r of results.slice(0, 15)) {
            const memClass = String(r.memory_class ?? '').toLowerCase();
            let type = 'state';
            if (memClass === 'identity') type = 'identity';
            else if (memClass === 'rule' || memClass === 'config') type = 'config';
            else if (memClass === 'preference') type = 'preference';
            else if (memClass === 'decision') type = 'decision';
            else if (memClass === 'temporal' || memClass === 'event') type = 'temporal';
            else if (memClass === 'relationship') type = 'relationship';

            searchResults.push({
              text: ((r.snippet as string) || (r.content as string) || '').slice(0, 140),
              confidence: typeof r.score === 'number' ? r.score * 100 : 50,
              source: (r.source_section as string) || (r.source_file as string)?.split('/').pop() || 'cortex',
              type,
            });
          }

          // Deduplicate by text similarity
          const seen = new Set<string>();
          searchResults = searchResults.filter(r => {
            const key = r.text.slice(0, 60).toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
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
