export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import path from 'path';

const HOME = process.env.HOME ?? '/tmp';
const STATE_DIR = path.join(HOME, '.cortex-ide');
const STATE_FILE = path.join(STATE_DIR, 'terminal-state.json');

/** GET — load persisted tab state */
export async function GET() {
  try {
    if (!existsSync(STATE_FILE)) {
      return NextResponse.json(null, { status: 404 });
    }
    const data = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    return NextResponse.json(data);
  } catch {
    return NextResponse.json(null, { status: 404 });
  }
}

/** POST — save tab state */
export async function POST(request: Request) {
  try {
    const state = await request.json();
    if (!existsSync(STATE_DIR)) {
      mkdirSync(STATE_DIR, { recursive: true });
    }
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to save state' },
      { status: 500 },
    );
  }
}
