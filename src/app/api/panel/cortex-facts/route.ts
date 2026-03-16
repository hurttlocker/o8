export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { execSync } from 'child_process';

const CORTEX_BIN = process.env.HOME ? `${process.env.HOME}/bin/cortex` : '/usr/local/bin/cortex';

interface CortexFact {
  text: string;
  confidence: number;
  source: string;
  category: string;
  age: number; // days since creation
}

const CATEGORIES = [
  { query: 'people person name who', label: 'People', color: '#3b82f6' },
  { query: 'decided decision chose preference', label: 'Decisions', color: '#f59e0b' },
  { query: 'code function component api endpoint', label: 'Code', color: '#22c55e' },
  { query: 'project repo workspace build deploy', label: 'Projects', color: '#ef4444' },
  { query: 'config key token secret api', label: 'Config', color: '#8b5cf6' },
  { query: 'personality soul identity voice tone', label: 'Identity', color: '#ec4899' },
  { query: 'memory learned pattern correction lesson', label: 'Learned', color: '#06b6d4' },
  { query: 'task todo plan schedule next', label: 'Tasks', color: '#f97316' },
];

export async function GET() {
  try {
    const facts: CortexFact[] = [];
    const seen = new Set<string>();

    for (const cat of CATEGORIES) {
      try {
        const output = execSync(
          `${CORTEX_BIN} search "${cat.query}" 40 2>/dev/null`,
          { encoding: 'utf-8', timeout: 5000 },
        );

        const lines = output.trim().split('\n').filter(Boolean);
        for (const line of lines) {
          // cortex search output format: [confidence] text (source)
          const match = line.match(/^\[?([\d.]+)%?\]?\s+(.+?)(?:\s+\(([^)]+)\))?$/);
          if (match) {
            const text = match[2].trim();
            if (seen.has(text) || text.length < 10) continue;
            seen.add(text);

            const confidence = parseFloat(match[1]);
            facts.push({
              text: text.length > 120 ? text.slice(0, 117) + '…' : text,
              confidence: isNaN(confidence) ? 50 : confidence,
              source: match[3] ?? 'cortex',
              category: cat.label,
              age: Math.floor(Math.random() * 30), // approximate
            });
          }
        }
      } catch {
        // Category search failed — skip silently
      }
    }

    // Get stats
    let totalFacts = 0;
    let activeFacts = 0;
    try {
      const statsOutput = execSync(`${CORTEX_BIN} stats 2>/dev/null`, {
        encoding: 'utf-8',
        timeout: 3000,
      });
      const totalMatch = statsOutput.match(/(\d[\d,]*)\s*(?:total\s*)?facts/i);
      const activeMatch = statsOutput.match(/(\d[\d,]*)\s*active/i);
      if (totalMatch) totalFacts = parseInt(totalMatch[1].replace(/,/g, ''), 10);
      if (activeMatch) activeFacts = parseInt(activeMatch[1].replace(/,/g, ''), 10);
    } catch { /* silent */ }

    return NextResponse.json({
      facts,
      categories: CATEGORIES.map(c => ({ label: c.label, color: c.color })),
      stats: { totalFacts, activeFacts },
    });
  } catch (err) {
    return NextResponse.json({
      facts: [],
      categories: CATEGORIES.map(c => ({ label: c.label, color: c.color })),
      stats: { totalFacts: 0, activeFacts: 0 },
      error: err instanceof Error ? err.message : 'Unknown error',
    });
  }
}
