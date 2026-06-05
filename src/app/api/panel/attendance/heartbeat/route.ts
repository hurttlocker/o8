import { NextResponse } from 'next/server';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The o8 webview POSTs here every ~60s while document.hasFocus(). The autonomous
// dogfood loop's attendance gate (~/o8-dogfood-gate.sh) treats a heartbeat file
// younger than 10 minutes as proof a human is present and stands down. Touching
// the file (mtime bump) is the signal; the body is informational. Loopback-gated
// via the existing /api/panel/ prefix in src/middleware.ts.
export async function POST() {
  try {
    const dataDir = process.env.CORTEX_IDE_DATA_DIR || join(homedir(), '.o8');
    await writeFile(join(dataDir, 'attended.heartbeat'), String(Date.now()), 'utf8');
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : 'heartbeat write failed' });
  }
}
