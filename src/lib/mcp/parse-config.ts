/**
 * Parses the standard Claude Desktop / Cursor MCP config snippet shape into
 * the normalized shape our "add external server" form consumes.
 *
 * Accepts any of:
 *
 *   1. Full config wrapper:
 *      { "mcpServers": { "filesystem": { "command": "npx", "args": [...] } } }
 *
 *   2. Object of servers (outer key = server name):
 *      { "filesystem": { "command": "npx", "args": [...] } }
 *
 *   3. Single server entry (no outer name key):
 *      { "command": "npx", "args": [...], "env": { ... } }
 *
 *   4. HTTP variant — any shape above with `url` / `httpUrl` / `type: "http"`
 *      on the inner object.
 *
 * Output — one or more `ParsedMcpServer` entries the caller can merge into
 * the form fields. If multiple servers are present (shape 1 or 2 with >1
 * entries), the caller can present a picker.
 */

export type ParsedMcpTransport = 'stdio' | 'http';

export interface ParsedMcpServer {
  name: string | null;
  transport: ParsedMcpTransport;
  command: string;
  args: string[];
  env: Record<string, string>;
  url?: string;
}

export interface ParsedMcpConfig {
  servers: ParsedMcpServer[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function coerceString(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function coerceStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => typeof entry === 'string' ? entry : '')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function coerceEnv(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== 'string') continue;
    const trimmedKey = key.trim();
    if (!trimmedKey) continue;
    out[trimmedKey] = raw;
  }
  return out;
}

function isHttpCandidate(entry: Record<string, unknown>): boolean {
  if (typeof entry.type === 'string' && entry.type.toLowerCase() === 'http') return true;
  if (typeof entry.transport === 'string' && entry.transport.toLowerCase() === 'http') return true;
  if (typeof entry.url === 'string' && entry.url.trim()) return true;
  if (typeof entry.httpUrl === 'string' && entry.httpUrl.trim()) return true;
  if (typeof entry.endpoint === 'string' && entry.endpoint.trim()) return true;
  return false;
}

function looksLikeServerEntry(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (typeof value.command === 'string' && value.command.trim()) return true;
  if (typeof value.url === 'string' && value.url.trim()) return true;
  if (typeof value.httpUrl === 'string' && value.httpUrl.trim()) return true;
  if (typeof value.endpoint === 'string' && value.endpoint.trim()) return true;
  return false;
}

function parseSingleEntry(name: string | null, raw: Record<string, unknown>): ParsedMcpServer {
  if (isHttpCandidate(raw)) {
    const url = coerceString(raw.url) || coerceString(raw.httpUrl) || coerceString(raw.endpoint) || coerceString(raw.command);
    if (!url) {
      throw new Error(`HTTP server "${name ?? 'unnamed'}" is missing a url`);
    }
    return {
      name,
      transport: 'http',
      command: url,
      args: [],
      env: coerceEnv(raw.env),
      url,
    };
  }

  const command = coerceString(raw.command);
  if (!command) {
    throw new Error(`Server "${name ?? 'unnamed'}" is missing a command`);
  }

  return {
    name,
    transport: 'stdio',
    command,
    args: coerceStringArray(raw.args),
    env: coerceEnv(raw.env),
  };
}

/**
 * Try to parse a JSON snippet the user pasted. Throws with an actionable
 * error message when the shape is unrecognizable.
 */
export function parseMcpConfigInput(raw: string): ParsedMcpConfig {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('Paste an MCP server config to populate the fields.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON — ${detail}`);
  }

  if (!isRecord(parsed)) {
    throw new Error('MCP config must be a JSON object.');
  }

  // Shape 1: { "mcpServers": { name: entry, ... } }
  if (isRecord(parsed.mcpServers)) {
    const servers: ParsedMcpServer[] = [];
    for (const [name, value] of Object.entries(parsed.mcpServers)) {
      if (!isRecord(value)) continue;
      servers.push(parseSingleEntry(name, value));
    }
    if (servers.length === 0) {
      throw new Error('"mcpServers" is empty — add at least one server entry.');
    }
    return { servers };
  }

  // Shape 3: single server entry (outer has command/url etc.)
  if (looksLikeServerEntry(parsed)) {
    return { servers: [parseSingleEntry(null, parsed)] };
  }

  // Shape 2: object of servers { name: entry, ... }
  const entries = Object.entries(parsed);
  const servers: ParsedMcpServer[] = [];
  for (const [name, value] of entries) {
    if (!isRecord(value)) continue;
    if (!looksLikeServerEntry(value)) continue;
    servers.push(parseSingleEntry(name, value));
  }

  if (servers.length > 0) {
    return { servers };
  }

  throw new Error('Unrecognized shape — expected {"mcpServers": {...}}, a map of servers, or a single {"command", "args"} object.');
}

/**
 * Render the normalized parsed server back into the existing form shape
 * (argsJson string, envJson string). Keeps the UI decoupled from JSON
 * serialization order.
 */
export function parsedServerToFormValues(server: ParsedMcpServer): {
  name: string;
  transport: ParsedMcpTransport;
  command: string;
  argsJson: string;
  envJson: string;
} {
  const argsJson = server.args.length > 0
    ? JSON.stringify(server.args, null, 2)
    : '[]';
  const envJson = Object.keys(server.env).length > 0
    ? JSON.stringify(server.env, null, 2)
    : '{}';
  return {
    name: server.name ?? '',
    transport: server.transport,
    command: server.command,
    argsJson,
    envJson,
  };
}
