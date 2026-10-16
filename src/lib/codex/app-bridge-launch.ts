import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { devMcpServerLaunch, findBundledMcpServer } from '@/lib/mcp/tool-spine/build';

/**
 * How to start the Codex app-server bridge (#3573). The packaged app ships it
 * beside the other server bundles; a source checkout runs the TypeScript entry.
 */
export function codexAppBridgeLaunch(): { command: string; args: string[] } {
  const bundled = findBundledMcpServer('codex-app-bridge.mjs');
  if (bundled) return { command: process.env.O8_NODE_BIN || 'node', args: [bundled] };
  return devMcpServerLaunch(resolve(dirname(fileURLToPath(import.meta.url)), 'app-server-exec-bridge.ts'));
}
