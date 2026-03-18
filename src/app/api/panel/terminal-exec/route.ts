export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { execSync } from 'child_process';

/**
 * POST /api/panel/terminal-exec
 * Sends a command to a tmux session via send-keys.
 * This is reliable — bypasses xterm rendering race conditions.
 */
export async function POST(request: Request) {
  try {
    const { sessionName, command } = await request.json();

    if (!sessionName || !command) {
      return NextResponse.json({ error: 'sessionName and command required' }, { status: 400 });
    }

    // Validate session name (prevent injection)
    if (!/^cortex-dash-[a-f0-9]+$/.test(sessionName)) {
      return NextResponse.json({ error: 'Invalid session name' }, { status: 400 });
    }

    // Wait for the clear command to finish, then send the actual command
    execSync(
      `tmux send-keys -t ${sessionName} ${JSON.stringify(command)} Enter`,
      { encoding: 'utf-8', timeout: 5000 },
    );

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to execute command' },
      { status: 500 },
    );
  }
}
