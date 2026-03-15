import { NextResponse } from 'next/server';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const CORTEX_BINARY = process.env.CORTEX_BINARY || path.join(os.homedir(), 'bin', 'cortex');

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { subject, factId, mode } = body;

    if (!subject && !factId) {
      return NextResponse.json({ error: 'subject or factId is required' }, { status: 400 });
    }

    const query = subject ?? String(factId);

    if (mode === 'impact') {
      // Impact analysis — blast radius for a subject
      const { stdout } = await execFileAsync(CORTEX_BINARY, [
        'mcp', '--port', '0', // We'll use CLI subcommands instead
      ], { timeout: 8000 });
      // Fallback: use search to approximate graph exploration
      const { stdout: searchOut } = await execFileAsync(CORTEX_BINARY, [
        'search', query, '10', '--json',
      ], { timeout: 8000, env: { ...process.env, NO_COLOR: '1' } });

      const results = JSON.parse(searchOut.trim());
      // Transform search results into graph-like nodes
      const nodes = results.map((r: Record<string, unknown>, i: number) => ({
        id: r.memory_id ?? i,
        label: typeof r.content === 'string' ? (r.content as string).slice(0, 100) : '',
        type: r.class ?? 'state',
        score: r.score ?? 0,
        source: r.source_section ?? r.source_file ?? '',
      }));

      return NextResponse.json({
        center: query,
        nodes,
        edges: nodes.slice(1).map((n: { id: number }, i: number) => ({
          source: nodes[0]?.id ?? 0,
          target: n.id,
          relation: 'related',
          weight: 1 - (i * 0.1),
        })),
      });
    }

    // Default: explore graph around a subject
    // Use fact query to find related facts
    const { stdout } = await execFileAsync(CORTEX_BINARY, [
      'search', query, '12', '--json',
    ], { timeout: 8000, env: { ...process.env, NO_COLOR: '1' } });

    const results = JSON.parse(stdout.trim());

    // Group by source section to create clusters
    const sectionMap = new Map<string, Array<Record<string, unknown>>>();
    for (const r of results) {
      const section = (r.source_section as string) ?? 'uncategorized';
      const existing = sectionMap.get(section) ?? [];
      existing.push(r);
      sectionMap.set(section, existing);
    }

    const nodes = results.map((r: Record<string, unknown>) => ({
      id: r.memory_id,
      label: typeof r.content === 'string' ? (r.content as string).slice(0, 120) : '',
      type: r.class ?? 'state',
      score: r.score ?? 0,
      source: r.source_file ?? '',
      section: r.source_section ?? '',
    }));

    // Create edges between facts in the same section (they're contextually related)
    const edges: Array<{ source: number; target: number; relation: string }> = [];
    for (const [, group] of sectionMap) {
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          edges.push({
            source: group[i].memory_id as number,
            target: group[j].memory_id as number,
            relation: 'same-context',
          });
        }
      }
    }

    return NextResponse.json({ center: query, nodes, edges });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Graph query failed' },
      { status: 500 },
    );
  }
}
