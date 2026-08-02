import { userInfo } from 'node:os';

export function resolveO8WebviewSocketPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
  username: string = userInfo().username,
): string {
  const explicitSocket = env.O8_TAURI_MCP_SOCKET?.trim();
  if (explicitSocket) {
    return explicitSocket;
  }

  if (env.O8_DATA_DIR?.trim() || env.CORTEX_IDE_DATA_DIR?.trim()) {
    throw new Error(
      'O8_TAURI_MCP_SOCKET is required when O8_DATA_DIR or CORTEX_IDE_DATA_DIR is set; '
      + 'refusing to fall back to the installed app WebView socket.',
    );
  }

  return `/tmp/tauri-mcp-o8-${username}.sock`;
}
