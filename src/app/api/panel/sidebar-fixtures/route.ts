import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NextResponse } from 'next/server';
import { getDataDir } from '@/lib/data-dir-migration';
import { sidebarFixturesSchema } from '@/lib/ui/sidebar-fixtures';

export const dynamic = 'force-dynamic';

/** Private, read-only display samples; absent from production and worker inventory. */
export async function GET() {
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json({ error: 'Development only' }, { status: 404 });
  }
  try {
    const source = await readFile(join(getDataDir(), 'ui-sidebar-fixtures.json'), 'utf8');
    if (Buffer.byteLength(source) > 1024 * 1024) throw new Error('Fixture exceeds limit');
    const payload = sidebarFixturesSchema.parse(JSON.parse(source));
    return NextResponse.json(payload, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return NextResponse.json({ schema: 'o8/ui-sidebar-fixtures/v1', synthetic: true, fixtures: [] });
    }
    return NextResponse.json({ error: 'Unable to read sidebar samples' }, { status: 500 });
  }
}
