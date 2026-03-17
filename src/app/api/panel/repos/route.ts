export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import {
  addRepo,
  listRepos,
  removeRepo,
  touchRepo,
  updateRepo,
  validateRepo,
} from '@/lib/repos/registry';
import type {
  RepoRegistryDeleteBody,
  RepoRegistryPostBody,
} from '@/lib/repos/types';

export async function GET() {
  try {
    const repos = await listRepos();
    return NextResponse.json({ repos });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unable to load repository registry.' },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  let body: RepoRegistryPostBody;
  try {
    body = (await request.json()) as RepoRegistryPostBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  try {
    const action = body.action ?? 'add';

    switch (action) {
      case 'validate': {
        if (!('localPath' in body) || !body.localPath?.trim()) {
          return NextResponse.json({ error: 'localPath is required.' }, { status: 400 });
        }
        const repo = await validateRepo(body.localPath);
        return NextResponse.json({ repo });
      }
      case 'add': {
        if (!('localPath' in body) || !body.localPath?.trim()) {
          return NextResponse.json({ error: 'localPath is required.' }, { status: 400 });
        }
        const repo = await addRepo(body.localPath);
        return NextResponse.json({ repo }, { status: 201 });
      }
      case 'update': {
        if (!('id' in body) || !body.id) {
          return NextResponse.json({ error: 'id is required.' }, { status: 400 });
        }
        const repo = await updateRepo(body.id, {
          setup: 'setup' in body ? body.setup : undefined,
          lastOpenedAt: 'lastOpenedAt' in body ? body.lastOpenedAt : undefined,
        });
        return NextResponse.json({ repo });
      }
      case 'touch': {
        if (!('id' in body) || !body.id) {
          return NextResponse.json({ error: 'id is required.' }, { status: 400 });
        }
        const repo = await touchRepo(
          body.id,
          'lastOpenedAt' in body ? body.lastOpenedAt ?? undefined : undefined,
        );
        return NextResponse.json({ repo });
      }
      default:
        return NextResponse.json({ error: 'Unsupported action.' }, { status: 400 });
    }
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unable to update repository registry.' },
      { status: 500 },
    );
  }
}

export async function DELETE(request: Request) {
  let body: RepoRegistryDeleteBody;
  try {
    body = (await request.json()) as RepoRegistryDeleteBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  if (!body.id) {
    return NextResponse.json({ error: 'id is required.' }, { status: 400 });
  }

  try {
    await removeRepo(body.id);
    return NextResponse.json({ ok: true, removedId: body.id });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unable to remove repository.' },
      { status: 500 },
    );
  }
}
