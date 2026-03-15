export const dynamic = 'force-dynamic';

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
    const { subject, factId, depth = 2 } = body;

    if (!subject && !factId) {
      return NextResponse.json({ error: 'subject or factId is required' }, { status: 400 });
    }

    // Use real Cortex graph traversal (cortex#338: --subject mode)
    const args = ['graph'];
    if (subject) {
      args.push('--subject', subject);
    } else {
      args.push(String(factId));
    }
    args.push('--depth', String(depth), '--export', 'json');

    const { stdout } = await execFileAsync(CORTEX_BINARY, args, {
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: '1' },
    });

    const graph = JSON.parse(stdout.trim());

    // Cortex graph JSON format: { nodes: [...], edges: [...], meta: {...} }
    // Transform to IDE format
    const nodes = (graph.nodes ?? []).map((n: Record<string, unknown>) => ({
      id: n.id,
      label: [n.subject, n.predicate, n.object].filter(Boolean).join(' ').slice(0, 120),
      type: n.fact_type ?? n.type ?? 'state',
      score: n.confidence ?? 0,
      source: n.source ?? '',
      section: n.subject ?? '',
      depth: n.depth ?? 0,
    }));

    const edges = (graph.edges ?? []).map((e: Record<string, unknown>) => ({
      source: e.source ?? e.source_fact_id,
      target: e.target ?? e.target_fact_id,
      relation: e.edge_type ?? e.type ?? 'relates_to',
      confidence: e.confidence ?? 0,
    }));

    return NextResponse.json({
      center: subject ?? `fact #${factId}`,
      nodes,
      edges,
      meta: graph.meta ?? {},
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Graph query failed';
    // If graph returns empty (no nodes for subject), return empty instead of 500
    if (message.includes('{}') || message.includes('No graph found')) {
      return NextResponse.json({ center: 'unknown', nodes: [], edges: [], meta: {} });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
