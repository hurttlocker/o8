export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { execSync } from 'child_process';

/** GET — list alive tmux sessions matching cortex-dash-* pattern */
export async function GET() {
  try {
    const output = execSync('tmux list-sessions -F "#{session_name}" 2>/dev/null || true', {
      encoding: 'utf-8',
      timeout: 3000,
    });
    const sessions = output
      .trim()
      .split('\n')
      .filter(s => s.startsWith('cortex-dash-'));
    return NextResponse.json({ sessions });
  } catch {
    return NextResponse.json({ sessions: [] });
  }
}
