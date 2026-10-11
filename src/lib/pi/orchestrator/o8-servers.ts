import { buildToolRegistry } from '@/lib/mcp/tool-spine/build';
import { entriesForSurface, type ToolProfile } from '@/lib/mcp/tool-spine/registry';
import { StdioJsonRpcPeer } from '@/lib/runtimes/shared/stdio-json-rpc';
import { buildNextUrl } from '@/lib/ws-server/next-fetch';
import { getOrCreateWsToken } from '@/lib/ws-auth';
import type { O8CommandServer, O8ServerRequest } from './o8-commands';

/** Long enough for blocking commands such as wait_for_mission_ready. */
const SERVER_REQUEST_TIMEOUT_MS = 15 * 60_000;

export interface O8ServerSet {
  servers: O8CommandServer[];
  close(): Promise<void>;
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('Stopped'));
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

let nextRequestId = 0;

/**
 * The operator server's in-app host, reached the way the operator stdio proxy
 * forwards every message: a JSON-RPC POST to /api/mcp with the ws token.
 */
export const operatorOverHttp: O8ServerRequest = async (method, params, signal) => {
  const response = await fetch(buildNextUrl('/api/mcp'), {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getOrCreateWsToken()}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: `pi-${++nextRequestId}`, method, params }),
    signal,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`The o8 operator server returned HTTP ${response.status}`);
  const message = JSON.parse(text) as { result?: unknown; error?: { message?: string } };
  if (message.error) throw new Error(message.error.message ?? 'The o8 operator server refused the request');
  return message.result;
};

async function openStdioServer(name: string, launch: { command: string; args?: string[]; env?: Record<string, string> },
  cwd: string): Promise<{ server: O8CommandServer; close: () => Promise<void> }> {
  const peer = new StdioJsonRpcPeer({ command: launch.command, args: launch.args ?? [], cwd,
    env: { ...process.env, ...launch.env } }, SERVER_REQUEST_TIMEOUT_MS);
  try {
    await peer.request('initialize', { protocolVersion: '2024-11-05', capabilities: {},
      clientInfo: { name: 'o8-pi-orchestrator', version: '1.0.0' } }, 60_000);
  } catch (error) {
    await peer.close({ gracefulMs: 200 });
    throw error;
  }
  return {
    server: { name, request: (method, params, signal) => abortable(peer.request(method, params), signal) },
    close: () => peer.close({ gracefulMs: 200 }),
  };
}

/**
 * Opens the built-in o8 servers the Claude orchestrator surface gets for this
 * repo and tool profile: the operator server and cortex (read-only on a
 * proposer turn), from the same tool-spine entries. User-configured external
 * servers are not attached to Pi.
 */
export async function openO8Servers(repoPath: string, options: {
  profile?: ToolProfile;
  threadId?: string | null;
  /** Test seam for the operator host. Production uses /api/mcp. */
  operatorRequest?: O8ServerRequest;
}): Promise<O8ServerSet> {
  const registry = buildToolRegistry(repoPath, { profile: options.profile, threadId: options.threadId });
  const servers: O8CommandServer[] = [];
  const closers: Array<() => Promise<void>> = [];
  const close = async () => { await Promise.allSettled(closers.map(closeServer => closeServer())); };
  try {
    for (const { name, config, entry } of entriesForSurface(registry, 'claude-orchestrator')) {
      if (entry.source !== 'builtin') continue;
      if (entry.id === 'builtin:operator') {
        servers.push({ name, request: options.operatorRequest ?? operatorOverHttp });
      } else if (config.type === 'stdio') {
        const opened = await openStdioServer(name, config, repoPath);
        closers.push(opened.close);
        servers.push(opened.server);
      }
    }
  } catch (error) {
    await close();
    throw error;
  }
  return { servers, close };
}
