export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getOrCreateWsToken } from '@/lib/ws-auth';
import { resolvePortInfo } from '@/lib/panel/api-port';

interface VoiceSession {
  name?: unknown;
  cwd?: unknown;
  commandHint?: unknown;
  createdAt?: unknown;
}

interface MobileTerminalSession {
  name: string;
  cwd?: string;
  commandHint?: string;
  createdAt?: number;
}

/**
 * GET /api/mobile/terminal-sessions
 *
 * The phone's live-terminal picker. Lists every PTY the ws-server is hosting
 * right now so the operator can scope a turn to a terminal or type into it. Thin
 * loopback proxy to the ws-server's internal `/terminal-voice-sessions` inventory
 * (the same source Symon's native terminal tools read). This CANONICAL mobile
 * route exists so the request can traverse the encrypted relay, where the
 * historical WS-port endpoint is unreachable; direct clients keep the WS-port
 * fallback. Gated to operator + enrolled device by src/middleware.ts. Any failure
 * degrades to an empty list — the picker shows its honest "no live terminals"
 * empty state rather than an error wall.
 *
 * Never hardcodes a port: the ws-server port is resolved via resolvePortInfo().
 */
export async function GET() {
  try {
    const wsToken = getOrCreateWsToken();
    const { wsPort } = resolvePortInfo();
    const response = await fetch(`http://127.0.0.1:${wsPort}/terminal-voice-sessions`, {
      headers: { Authorization: `Bearer ${wsToken}` },
      cache: 'no-store',
    });
    if (!response.ok) {
      return NextResponse.json({ sessions: [] });
    }
    const data = (await response.json()) as { sessions?: VoiceSession[] };
    const sessions: MobileTerminalSession[] = (data.sessions ?? [])
      .filter((s): s is VoiceSession => Boolean(s) && typeof s === 'object' && typeof s.name === 'string')
      .map((s) => {
        const out: MobileTerminalSession = { name: s.name as string };
        if (typeof s.cwd === 'string' && s.cwd) out.cwd = s.cwd;
        if (typeof s.commandHint === 'string' && s.commandHint) out.commandHint = s.commandHint;
        // ws-server emits createdAt as an ISO string; the mobile contract is epoch ms.
        if (typeof s.createdAt === 'string') {
          const ms = Date.parse(s.createdAt);
          if (Number.isFinite(ms)) out.createdAt = ms;
        } else if (typeof s.createdAt === 'number' && Number.isFinite(s.createdAt)) {
          out.createdAt = s.createdAt;
        }
        return out;
      });
    return NextResponse.json({ sessions });
  } catch {
    return NextResponse.json({ sessions: [] });
  }
}
