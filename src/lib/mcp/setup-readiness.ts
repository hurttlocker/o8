import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface McpSetupReadiness {
  ready: boolean;
  reason: string | null;
  detail: string | null;
}

export function getMcpSetupReadiness(): McpSetupReadiness {
  const packaged = process.env.O8_PACKAGED_APP === '1';
  const bundledPath = process.env.O8_BUNDLED_MCP_PATH;
  if (!packaged) {
    return { ready: true, reason: null, detail: null };
  }
  if (bundledPath && existsSync(bundledPath)) {
    const codebaseMemoryBin = process.env.O8_CODEBASE_MEMORY_BIN
      || join(homedir(), '.o8', 'bin', process.platform === 'win32' ? 'codebase-memory-mcp.exe' : 'codebase-memory-mcp');
    if (existsSync(codebaseMemoryBin)) {
      return { ready: true, reason: null, detail: null };
    }
    return {
      ready: false,
      reason: 'codebase_memory_not_ready',
      detail: 'o8 is still downloading codebase-memory for first launch. Wait for startup to finish, then run Connect again.',
    };
  }
  return {
    ready: false,
    reason: 'bundled_mcp_not_ready',
    detail: 'o8 is still finishing first launch. Wait for startup to finish, then run Connect again.',
  };
}
