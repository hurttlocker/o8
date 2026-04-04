import { NextResponse } from 'next/server';
import { readRepoPathRegistry } from '@/lib/repos/repo-path-registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const registry = await readRepoPathRegistry();
  if (!registry.ok) {
    return NextResponse.json(
      { error: registry.message },
      { status: 500 },
    );
  }

  return NextResponse.json(registry.repos);
}
