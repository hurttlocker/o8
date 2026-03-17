import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { invalidateInboxCache } from '@/lib/mobile/openclaw';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const execFileAsync = promisify(execFile);

export async function POST(request: NextRequest) {
  const payload = (await request.json().catch(() => null)) as
    | { sessionKey?: string; pid?: number }
    | null;

  const sessionKey = payload?.sessionKey?.trim();
  if (!sessionKey) {
    return NextResponse.json({ error: 'sessionKey is required' }, { status: 400 });
  }

  try {
    // For codex terminals, find the PID from the session key or process list
    // Session keys look like: codex:019ceac7-4bc0-74d1-8d5e-d0f7aaf1a088
    const isCodex = sessionKey.startsWith('codex:') || sessionKey.startsWith('codex-owned:');
    const isClaudeCode = sessionKey.startsWith('claude-code:');

    if (!isCodex && !isClaudeCode) {
      return NextResponse.json({ error: 'Only Codex/Claude Code sessions can be killed from here' }, { status: 400 });
    }

    // Claude Code sessions — extract PID from session key (claude-code:live-PID)
    if (isClaudeCode) {
      const pidMatch = sessionKey.match(/live-(\d+)$/);
      if (pidMatch) {
        const pid = Number(pidMatch[1]);
        try {
          process.kill(pid, 'SIGTERM');
          invalidateInboxCache();
          return NextResponse.json({ success: true, method: 'claude-code-pid', pid });
        } catch {
          invalidateInboxCache();
          return NextResponse.json({ success: true, method: 'already-dead', pid });
        }
      }
      return NextResponse.json({ error: 'Could not extract PID from Claude Code session key' }, { status: 400 });
    }

    // Try to find and kill the codex process
    // First check if we have a direct PID
    if (payload?.pid && Number.isFinite(payload.pid)) {
      try {
        process.kill(payload.pid, 'SIGTERM');
        invalidateInboxCache();
        return NextResponse.json({ success: true, method: 'direct-pid', pid: payload.pid });
      } catch (e) {
        invalidateInboxCache();
        return NextResponse.json({ success: true, method: 'already-dead', pid: payload.pid });
      }
    }

    // Find codex processes via ps
    const { stdout } = await execFileAsync(
      'bash', ['-c', 'ps -eo pid=,command= | grep codex | grep -v grep'],
      { maxBuffer: 128 * 1024, timeout: 5000 },
    ).catch(() => ({ stdout: '' }));

    const codexPids: number[] = [];
    for (const line of stdout.split('\n').filter(Boolean)) {
      const match = line.trim().match(/^(\d+)/);
      if (match) codexPids.push(Number(match[1]));
    }

    if (codexPids.length === 0) {
      return NextResponse.json({ success: false, error: 'No codex processes found' }, { status: 404 });
    }

    // For codex-owned sessions, try to match by session ID in the process args
    const sessionId = sessionKey.replace('codex:', '').replace('codex-owned:', '');
    let killed = false;

    for (const pid of codexPids) {
      try {
        // Check if this process's command line contains our session ID
        const { stdout: cmdLine } = await execFileAsync(
          'bash', ['-c', `ps -p ${pid} -o command= 2>/dev/null || true`],
          { maxBuffer: 16 * 1024, timeout: 3000 },
        ).catch(() => ({ stdout: '' }));

        if (cmdLine.includes(sessionId) || codexPids.length === 1) {
          process.kill(pid, 'SIGTERM');
          killed = true;
          invalidateInboxCache();
          return NextResponse.json({ success: true, method: 'matched-pid', pid });
        }
      } catch { /* process might have died during check */ }
    }

    if (!killed) {
      // Return the list of codex PIDs so the UI can show them
      return NextResponse.json({
        success: false,
        error: 'Could not match session to a specific process',
        codexPids,
      }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Kill failed' },
      { status: 500 },
    );
  }
}
