export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { readFileSync, statSync } from 'fs';
import path from 'path';
import { getOrCreateWsToken } from '@/lib/ws-auth';

/**
 * POST /api/panel/terminal-image
 * Reads an image file and returns the IIP escape sequence.
 * If sessionName is provided, also notifies connected WS clients
 * to render the image directly in xterm (bypassing tmux).
 */
export async function POST(request: Request) {
  try {
    const wsToken = getOrCreateWsToken();
    const { filePath, sessionName } = await request.json();

    if (!filePath) {
      return NextResponse.json({ error: 'filePath required' }, { status: 400 });
    }

    // Resolve ~ to home dir
    const resolved = filePath.replace(/^~/, process.env.HOME ?? '/tmp');

    const stat = statSync(resolved);
    if (!stat.isFile()) {
      return NextResponse.json({ error: 'Not a file' }, { status: 400 });
    }

    if (stat.size > 20_000_000) {
      return NextResponse.json({ error: 'File too large (20MB max)' }, { status: 400 });
    }

    const fileData = readFileSync(resolved);
    const b64 = fileData.toString('base64');
    const filename = path.basename(resolved);
    const filenameB64 = Buffer.from(filename).toString('base64');

    const iip = `\x1b]1337;File=name=${filenameB64};size=${stat.size};inline=1:${b64}\x07\n`;

    // If we have a session name, send the image via WS to the right terminal
    // The WS server handles this through the terminal-image message type
    if (sessionName) {
      try {
        // Notify WS server by writing a signal file that triggers image rendering
        // The actual rendering happens through the WS terminal-image handler
        const WebSocket = (await import('ws')).default;
        const ws = new WebSocket(`ws://localhost:3002/ws?token=${encodeURIComponent(wsToken)}`);
        await new Promise<void>((resolve, reject) => {
          ws.on('open', () => {
            ws.send(JSON.stringify({
              type: 'terminal-image',
              sessionName,
              filePath: resolved,
            }));
            ws.close();
            resolve();
          });
          ws.on('error', reject);
          setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 3000);
        });
      } catch {
        // WS delivery failed — still return the IIP for direct use
      }
    }

    return NextResponse.json({ ok: true, iip });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to load image' },
      { status: 500 },
    );
  }
}
