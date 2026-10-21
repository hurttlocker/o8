import { NextRequest, NextResponse } from 'next/server';
import { getReleaseNotes, normalizeReleaseVersion } from '@/lib/app-update/release-notes';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Shared published notes, cached per version. Opening a hover never calls a model. */
export async function GET(request: NextRequest) {
  const version = normalizeReleaseVersion(request.nextUrl.searchParams.get('version')?.trim() ?? 'latest');
  if (!version) return NextResponse.json({ error: 'Invalid release version.' }, { status: 400 });
  try {
    return NextResponse.json(await getReleaseNotes(version), { headers: { 'Cache-Control': 'private, max-age=1800' } });
  } catch {
    return NextResponse.json({ error: 'Published notes are unavailable. Try again or open the release history.' }, { status: 503 });
  }
}
