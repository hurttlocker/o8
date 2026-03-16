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
  match_type?: string;
}

const CATEGORIES = [
  { query: 'people person name who family', label: 'People', color: '#3b82f6' },
  { query: 'decided decision chose preference want', label: 'Decisions', color: '#f59e0b' },
  { query: 'code function component api endpoint route', label: 'Code', color: '#22c55e' },
  { query: 'project repo workspace build deploy ship', label: 'Projects', color: '#ef4444' },
  { query: 'config key token secret password api', label: 'Config', color: '#8b5cf6' },
  { query: 'personality soul identity voice tone style', label: 'Identity', color: '#ec4899' },
  { query: 'memory learned pattern correction lesson mistake', label: 'Learned', color: '#06b6d4' },
  { query: 'task todo plan schedule next priority', label: 'Tasks', color: '#f97316' },
];

export async function GET() {
  try {
    const facts: CortexFact[] = [];
    const seen = new Set<string>();

    for (const cat of CATEGORIES) {
      try {
        const output = execSync(
          `${CORTEX_BIN} search "${cat.query}" 40 2>/dev/null`,
          { encoding: 'utf-8', timeout: 8000 },
        );

        let results: CortexResult[] = [];
        try {
          results = JSON.parse(output);
        } catch {
          // Try line-by-line fallback
          continue;
        }

        if (!Array.isArray(results)) continue;

        for (const r of results) {
          const text = r.snippet || (r.content ? r.content.slice(0, 120) : '');
          if (!text || text.length < 10) continue;

          const cleanText = text.replace(/^[#\s]+/, '').trim();
          const key = cleanText.slice(0, 60);
          if (seen.has(key)) continue;
          seen.add(key);

          const confidence = typeof r.score === 'number'
            ? Math.min(r.score * 100, 100)
            : 50;

          facts.push({
            text: cleanText.length > 120 ? cleanText.slice(0, 117) + '…' : cleanText,
            confidence,
            source: r.source_section || r.source_file || 'cortex',
            category: cat.label,
          });
        }
      } catch {
        // Category search failed — skip
      }
    }

    // Get stats from cortex binary (outputs JSON)
    let totalFacts = 0;
    let activeFacts = 0;
    let totalMemories = 0;
    try {
      const statsOutput = execSync(`${CORTEX_BIN} stats 2>/dev/null`, {
        encoding: 'utf-8',
        timeout: 3000,
      });
      const statsJson = JSON.parse(statsOutput);
      totalFacts = statsJson.facts ?? 0;
      totalMemories = statsJson.memories ?? 0;
      // Active = high confidence facts
      activeFacts = statsJson.confidence_distribution?.high ?? totalFacts;
    } catch { /* silent */ }

    return NextResponse.json({
      facts,
      categories: CATEGORIES.map(c => ({ label: c.label, color: c.color })),
      stats: { totalFacts, activeFacts, totalMemories },
    });
  } catch (err) {
    return NextResponse.json({
      facts: [],
      categories: CATEGORIES.map(c => ({ label: c.label, color: c.color })),
      stats: { totalFacts: 0, activeFacts: 0, totalMemories: 0 },
      error: err instanceof Error ? err.message : 'Unknown error',
    });
  }
}
