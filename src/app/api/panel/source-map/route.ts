import { NextRequest, NextResponse } from 'next/server';
import { findSourceMatches, type PickedElement } from '@/lib/browser/source-mapper';
import { requirePanelAuth } from '@/lib/panel/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface SourceMapRequestBody {
  element?: PickedElement;
  workspace?: string;
}

export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) {
    return denied;
  }

  const body = await request.json().catch(() => null) as SourceMapRequestBody | null;
  if (!body || !isPickedElement(body.element) || typeof body.workspace !== 'string' || !body.workspace.trim()) {
    return NextResponse.json({ error: 'element and workspace are required', matches: [], bestMatch: null }, { status: 400 });
  }

  try {
    const matches = await findSourceMatches(body.element, body.workspace);
    return NextResponse.json({
      matches,
      bestMatch: matches[0] ?? null,
    });
  } catch (error) {
    console.error('[source-map] Failed to map selected element', error);
    return NextResponse.json(
      { error: 'Failed to map selected element', matches: [], bestMatch: null },
      { status: 500 },
    );
  }
}

function isPickedElement(value: unknown): value is PickedElement {
  if (!value || typeof value !== 'object') return false;

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.tagName === 'string'
    && (candidate.selector === undefined || typeof candidate.selector === 'string')
    && (candidate.text === undefined || typeof candidate.text === 'string')
    && (candidate.textContent === undefined || typeof candidate.textContent === 'string')
    && (candidate.classes === undefined || Array.isArray(candidate.classes))
    && (candidate.classList === undefined || Array.isArray(candidate.classList))
    && (candidate.styles === undefined || (candidate.styles !== null && typeof candidate.styles === 'object'))
  );
}
