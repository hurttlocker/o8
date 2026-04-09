export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { listDirectives, createDirective } from '@/lib/cortex/directives-store';

export async function GET() {
  try {
    const directives = listDirectives();
    return NextResponse.json({ directives });
  } catch (error) {
    console.error('[directives] list error:', error);
    return NextResponse.json({ error: 'Failed to list directives' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { title, scope, repoName, priority, content } = body;

    if (typeof title !== 'string' || title.trim() === '') {
      return NextResponse.json({ error: 'title is required' }, { status: 400 });
    }

    const directive = createDirective({
      title: title.trim(),
      scope: scope || 'global',
      repoName: repoName || null,
      priority: priority ?? 50,
      content: content ?? '',
    });

    return NextResponse.json({ directive }, { status: 201 });
  } catch (error) {
    console.error('[directives] create error:', error);
    return NextResponse.json({ error: 'Failed to create directive' }, { status: 500 });
  }
}
