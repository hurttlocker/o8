/**
 * Emitter: Codex orchestrator `config.toml` mcp_servers blocks (Set A).
 *
 * `serializeCodexMcpServers` + the TOML helpers are reproduced here verbatim
 * from `lane/codex-orchestrator-session.ts` (Step C will repoint that file to
 * import from here and delete the local copy). Byte-for-byte invariants the
 * golden test pins: a blank line between blocks, `type = "http"` discriminator
 * for HTTP servers, env/headers sorted via `localeCompare`, `tomlKey` quoting,
 * and NO trailing newline (the caller's `mergeCodexMcpConfig` adds it).
 */

import type { OrchestratorMcpServerConfig } from '@/lib/mcp/external-servers';
import { entriesForSurface, type ToolRegistry } from './registry';

function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlStringArray(values: string[]): string {
  return `[${values.map((value) => tomlString(value)).join(', ')}]`;
}

function serializeStringMap(sectionName: string, values: Record<string, string> | undefined): string[] {
  if (!values || Object.keys(values).length === 0) {
    return [];
  }

  return [
    `[${sectionName}]`,
    ...Object.entries(values)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${tomlKey(key)} = ${tomlString(value)}`),
  ];
}

export function serializeCodexMcpServers(servers: Record<string, OrchestratorMcpServerConfig>): string {
  const lines: string[] = [];

  for (const [name, server] of Object.entries(servers)) {
    if (lines.length > 0) {
      lines.push('');
    }

    const serverSection = `mcp_servers.${tomlKey(name)}`;
    lines.push(`[${serverSection}]`);
    if (server.type === 'http') {
      lines.push('type = "http"');
      lines.push(`url = ${tomlString(server.url)}`);
      const headerLines = serializeStringMap(`${serverSection}.headers`, server.headers);
      if (headerLines.length > 0) {
        lines.push('', ...headerLines);
      }
      continue;
    }

    lines.push(`command = ${tomlString(server.command)}`);
    lines.push(`args = ${tomlStringArray(server.args)}`);
    const envLines = serializeStringMap(`${serverSection}.env`, server.env);
    if (envLines.length > 0) {
      lines.push('', ...envLines);
    }
  }

  return lines.join('\n');
}

export function toCodexServersMap(r: ToolRegistry): Record<string, OrchestratorMcpServerConfig> {
  const out: Record<string, OrchestratorMcpServerConfig> = {};
  for (const { name, config } of entriesForSurface(r, 'codex-orchestrator')) {
    out[name] = config;
  }
  return out;
}

export function toCodexToml(r: ToolRegistry): string {
  return serializeCodexMcpServers(toCodexServersMap(r));
}
