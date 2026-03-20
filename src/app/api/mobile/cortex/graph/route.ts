export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getCortexClient } from '@/lib/cortex/client';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { subject, factId, depth = 2 } = body;

    if (!subject && !factId) {
      return NextResponse.json({ error: 'subject or factId is required' }, { status: 400 });
    }

    const client = getCortexClient();
    const graph = await client.graph({ subject, factId, depth });

    if (!graph) {
      return NextResponse.json({ center: subject ?? `fact #${factId}`, nodes: [], edges: [], meta: {} });
    }

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
    if (message.includes('{}') || message.includes('No graph found')) {
      return NextResponse.json({ center: 'unknown', nodes: [], edges: [], meta: {} });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
