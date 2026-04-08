export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getDirective, updateDirective, deleteDirective } from '@/lib/cortex/directives-store';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const directive = getDirective(id);
    if (!directive) {
      return NextResponse.json({ error: 'Directive not found' }, { status: 404 });
    }
    return NextResponse.json({ directive });
  } catch (error) {
    console.error('[directives] get error:', error);
    return NextResponse.json({ error: 'Failed to get directive' }, { status: 500 });
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { title, scope, repoName, priority, content } = body;

    const updated = updateDirective(id, {
      title,
      scope,
      repoName,
      priority,
      content,
    });

    if (!updated) {
      return NextResponse.json({ error: 'Directive not found' }, { status: 404 });
    }

    return NextResponse.json({ directive: updated });
  } catch (error) {
    console.error('[directives] update error:', error);
    return NextResponse.json({ error: 'Failed to update directive' }, { status: 500 });
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const deleted = deleteDirective(id);
    if (!deleted) {
      return NextResponse.json({ error: 'Directive not found' }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[directives] delete error:', error);
    return NextResponse.json({ error: 'Failed to delete directive' }, { status: 500 });
  }
}
