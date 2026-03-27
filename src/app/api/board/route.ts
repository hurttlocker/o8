import { NextRequest, NextResponse } from 'next/server';
import { BoardConflictError, BoardMutationError, getBoardSnapshot, mutateBoardState } from '@/lib/board/state';
import type { BoardMutation } from '@/lib/board/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface BoardMutationRequestBody {
  repo: string;
  expectedRevision?: number;
  mutation: BoardMutation;
}

export async function GET(request: NextRequest) {
  const repo = request.nextUrl.searchParams.get('repo')?.trim();
  if (!repo) {
    return NextResponse.json({ error: 'repo is required' }, { status: 400 });
  }

  try {
    const snapshot = await getBoardSnapshot(repo);
    return NextResponse.json(snapshot, {
      headers: {
        'Cache-Control': 'no-store, max-age=0',
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unable to load board state' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as BoardMutationRequestBody | null;
  const repo = body?.repo?.trim();
  if (!repo || !body?.mutation) {
    return NextResponse.json({ error: 'repo and mutation are required' }, { status: 400 });
  }

  try {
    await mutateBoardState(repo, body.mutation, {
      expectedRevision: body.expectedRevision,
    });
    const snapshot = await getBoardSnapshot(repo);
    return NextResponse.json(snapshot, {
      headers: {
        'Cache-Control': 'no-store, max-age=0',
      },
    });
  } catch (error) {
    if (error instanceof BoardConflictError) {
      return NextResponse.json(
        {
          error: error.message,
          currentRevision: error.currentRevision,
        },
        { status: 409 },
      );
    }
    if (error instanceof BoardMutationError) {
      return NextResponse.json(
        {
          error: error.message,
          code: error.code,
        },
        { status: 400 },
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unable to update board state' },
      { status: 500 },
    );
  }
}
