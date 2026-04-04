export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { listRepos } from '@/lib/repos/registry';

export async function GET() {
  try {
    return NextResponse.json({ repos: await listRepos() });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unable to load repositories.' },
      { status: 500 },
    );
  }
}
