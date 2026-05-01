import { NextResponse, type NextRequest } from 'next/server';
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// o8.md — repo-scoped spec/notes file. Lives at <repoPath>/o8.md so the
// orchestrator can read it from disk during context assembly the same way
// it reads CLAUDE.md / AGENTS.md. Operator and agents share this surface:
// operator edits via the Spec tab, agents read on dispatch + can write
// back via the existing repo-write tool path.

const MAX_BYTES = 256 * 1024;

function resolveSpecPath(repoPath: string): string | null {
  if (!repoPath || typeof repoPath !== 'string') return null;
  if (!existsSync(repoPath)) return null;
  try {
    const s = statSync(repoPath);
    if (!s.isDirectory()) return null;
  } catch { return null; }
  return join(repoPath, 'o8.md');
}

const DEFAULT_TEMPLATE = `# o8 Spec

> One-page spec for this repo. Operator edits here. Agents read this on
> dispatch and can write back when they need to record a decision.

## Mission

What this repo exists to do, in one paragraph.

## Active scope

- [ ] Goal you're working on right now
- [ ] Next thing after that

## Constraints

- Hard rules the orchestrator must respect.

## Open questions

- Things you want surfaced for the operator before action.
`;

export async function GET(request: NextRequest) {
  const repoPath = request.nextUrl.searchParams.get('repoPath') ?? '';
  const specPath = resolveSpecPath(repoPath);
  if (!specPath) {
    return NextResponse.json({ ok: false, error: 'repoPath invalid' }, { status: 400 });
  }
  if (!existsSync(specPath)) {
    return NextResponse.json({ ok: true, content: DEFAULT_TEMPLATE, exists: false, path: specPath });
  }
  const content = readFileSync(specPath, 'utf-8');
  return NextResponse.json({ ok: true, content, exists: true, path: specPath });
}

export async function PUT(request: NextRequest) {
  const repoPath = request.nextUrl.searchParams.get('repoPath') ?? '';
  const specPath = resolveSpecPath(repoPath);
  if (!specPath) {
    return NextResponse.json({ ok: false, error: 'repoPath invalid' }, { status: 400 });
  }
  const body = await request.json().catch(() => null) as { content?: unknown } | null;
  const content = typeof body?.content === 'string' ? body.content : null;
  if (content === null) {
    return NextResponse.json({ ok: false, error: 'content must be a string' }, { status: 400 });
  }
  if (Buffer.byteLength(content, 'utf-8') > MAX_BYTES) {
    return NextResponse.json({ ok: false, error: `content exceeds ${MAX_BYTES} bytes` }, { status: 400 });
  }
  mkdirSync(dirname(specPath), { recursive: true });
  writeFileSync(specPath, content, 'utf-8');
  return NextResponse.json({ ok: true, path: specPath, bytes: Buffer.byteLength(content, 'utf-8') });
}
