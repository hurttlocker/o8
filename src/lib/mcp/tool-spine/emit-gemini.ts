/**
 * Emitter: Gemini CLI `~/.gemini/settings.json` mcpServers (NEW — closes the gap).
 *
 * The Gemini runtime had no MCP injection. This ships it. Schema verified
 * against the installed Gemini CLI + `google-gemini/gemini-cli`
 * docs/tools/mcp-server.md (2026-06): top key `mcpServers`; stdio is implied by
 * `command` (NO `type` field) with optional `args`/`env`; the streamable-HTTP
 * URL field is `httpUrl` (NOT `url` — `url` is the SSE field), with `headers`.
 * o8's operator server is streamable-HTTP-or-stdio, so it maps to `httpUrl`/
 * `command` accordingly. Empty `env` is omitted to match the CLI's own format.
 *
 * Surfaces: operator ("o8") + codebase-memory.
 */

import { entriesForSurface, type ToolRegistry } from './registry';

export function toGeminiSettings(r: ToolRegistry): { mcpServers: Record<string, unknown> } {
  const mcpServers: Record<string, unknown> = {};
  for (const { name, config } of entriesForSurface(r, 'gemini')) {
    mcpServers[name] = config.type === 'http'
      ? { httpUrl: config.url, ...(config.headers ? { headers: config.headers } : {}) }
      : {
          command: config.command,
          args: config.args,
          ...(config.env && Object.keys(config.env).length ? { env: config.env } : {}),
        };
  }
  return { mcpServers };
}
