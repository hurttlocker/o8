const WS_PORT = Number(process.env.WS_PORT ?? 3002);
const WS_TOKEN = process.env.WS_TOKEN ?? 'cortex-ide';

interface SpawnBridgeTerminalRequest {
  sessionName: string;
  shellCommand: string;
  cwd: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
}

interface SpawnBridgeTerminalResponse {
  ok: boolean;
  sessionName: string;
  pid?: number | null;
  error?: string;
}

function bridgeUrl(path: string) {
  return `http://127.0.0.1:${WS_PORT}${path}`;
}

export async function spawnBridgeTerminalSession(payload: SpawnBridgeTerminalRequest) {
  const response = await fetch(bridgeUrl('/terminal-spawn'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${WS_TOKEN}`,
    },
    body: JSON.stringify(payload),
    cache: 'no-store',
  });
  const data = await response.json().catch(() => ({})) as SpawnBridgeTerminalResponse;
  if (!response.ok || !data.ok) {
    throw new Error(data.error || 'Unable to spawn terminal session through the bridge.');
  }
  return data;
}

export async function isBridgeSessionAlive(sessionName: string): Promise<boolean> {
  try {
    const response = await fetch(bridgeUrl(`/terminal-alive?session=${encodeURIComponent(sessionName)}`), {
      method: 'GET',
      headers: { Authorization: `Bearer ${WS_TOKEN}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return false;
    const data = await response.json() as { alive?: boolean };
    return data.alive === true;
  } catch {
    return false;
  }
}

export async function signalBridgeTerminalSession(sessionName: string, signal: 'SIGINT' | 'SIGTERM' = 'SIGTERM') {
  const response = await fetch(bridgeUrl('/terminal-signal'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${WS_TOKEN}`,
    },
    body: JSON.stringify({ sessionName, signal }),
    cache: 'no-store',
  });
  const data = await response.json().catch(() => ({})) as { ok?: boolean; error?: string };
  if (!response.ok || !data.ok) {
    throw new Error(data.error || 'Unable to signal terminal session through the bridge.');
  }
}
