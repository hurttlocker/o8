/** Parse user-provided MCP commands, URLs, and supported JSON config shapes. */

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

const STDIO_KEYS = new Set(['command', 'args', 'env', 'type', 'transport']);
const HTTP_KEYS = new Set(['command', 'url', 'httpUrl', 'endpoint', 'type', 'transport']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string, name: string | null): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Server "${name ?? 'unnamed'}" is missing ${field}`);
  }
  return value.trim();
}

function parseStringArray(value: unknown, name: string | null): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`Server "${name ?? 'unnamed'}" args must be an array of strings.`);
  }
  return [...value] as string[];
}

function parseEnv(value: unknown, name: string | null): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    throw new Error(`Server "${name ?? 'unnamed'}" env must be an object of string values.`);
  }
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    const normalizedKey = key.trim();
    if (!normalizedKey || typeof raw !== 'string') {
      throw new Error(`Server "${name ?? 'unnamed'}" env must be an object of string values.`);
    }
    out[normalizedKey] = raw;
  }
  return out;
}

function isHttpCandidate(entry: Record<string, unknown>): boolean {
  const declared = typeof entry.type === 'string'
    ? entry.type.toLowerCase()
    : typeof entry.transport === 'string'
      ? entry.transport.toLowerCase()
      : null;
  if (declared === 'http') return true;
  return ['url', 'httpUrl', 'endpoint'].some((key) => (
    typeof entry[key] === 'string' && Boolean((entry[key] as string).trim())
  ));
}

function looksLikeServerEntry(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return ['command', 'url', 'httpUrl', 'endpoint'].some((key) => (
    typeof value[key] === 'string' && Boolean((value[key] as string).trim())
  ));
}

function rejectUnknownKeys(raw: Record<string, unknown>, allowed: ReadonlySet<string>, name: string | null): void {
  const unknown = Object.keys(raw).filter((key) => !allowed.has(key));
  if (unknown.length === 0) return;
  throw new Error(
    `Server "${name ?? 'unnamed'}" has unsupported field${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}. Remove ${unknown.length === 1 ? 'it' : 'them'} so no config is lost.`,
  );
}

function validateDeclaredTransport(raw: Record<string, unknown>, name: string | null): void {
  for (const key of ['type', 'transport'] as const) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== 'string' || !['stdio', 'http'].includes(raw[key].toLowerCase())) {
      throw new Error(`Server "${name ?? 'unnamed'}" has unsupported ${key} "${String(raw[key])}".`);
    }
  }
}

function parseHttpUrl(raw: string, name: string | null): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Server "${name ?? 'unnamed'}" has an invalid URL.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Server "${name ?? 'unnamed'}" URL must use http or https.`);
  }
  return raw;
}

function parseSingleEntry(name: string | null, raw: Record<string, unknown>): ParsedMcpServer {
  validateDeclaredTransport(raw, name);
  if (isHttpCandidate(raw)) {
    rejectUnknownKeys(raw, HTTP_KEYS, name);
    const candidate = ['url', 'httpUrl', 'endpoint', 'command']
      .map((key) => raw[key])
      .find((value): value is string => typeof value === 'string' && Boolean(value.trim()));
    const url = parseHttpUrl(requiredString(candidate, 'a URL', name), name);
    return { name, transport: 'http', command: url, args: [], env: {}, url };
  }

  rejectUnknownKeys(raw, STDIO_KEYS, name);
  return {
    name,
    transport: 'stdio',
    command: requiredString(raw.command, 'a command', name),
    args: parseStringArray(raw.args, name),
    env: parseEnv(raw.env, name),
  };
}

/** Parse the supported Claude Desktop / Cursor MCP JSON shapes. */
export function parseMcpConfigInput(raw: string): ParsedMcpConfig {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('Paste an MCP server config first.');

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON: ${detail}`);
  }
  if (!isRecord(parsed)) throw new Error('MCP config must be a JSON object.');

  if ('mcpServers' in parsed) {
    const wrapperKeys = Object.keys(parsed).filter((key) => key !== 'mcpServers');
    if (wrapperKeys.length > 0) {
      throw new Error(`Unsupported top-level field${wrapperKeys.length === 1 ? '' : 's'}: ${wrapperKeys.join(', ')}.`);
    }
    if (!isRecord(parsed.mcpServers)) throw new Error('"mcpServers" must be an object.');
    const servers = Object.entries(parsed.mcpServers).map(([name, value]) => {
      if (!isRecord(value)) throw new Error(`Server "${name}" must be a JSON object.`);
      return parseSingleEntry(name, value);
    });
    if (servers.length === 0) throw new Error('"mcpServers" is empty. Add at least one server entry.');
    return { servers };
  }

  if (looksLikeServerEntry(parsed)) return { servers: [parseSingleEntry(null, parsed)] };

  const servers = Object.entries(parsed).map(([name, value]) => {
    if (!isRecord(value) || !looksLikeServerEntry(value)) {
      throw new Error(`Server "${name}" must contain a command or URL.`);
    }
    return parseSingleEntry(name, value);
  });
  if (servers.length > 0) return { servers };
  throw new Error('Expected {"mcpServers": {...}}, a map of servers, or one server object.');
}

export function parsedServerToFormValues(server: ParsedMcpServer): {
  name: string;
  transport: ParsedMcpTransport;
  command: string;
  argsJson: string;
  envJson: string;
} {
  return {
    name: server.name ?? '',
    transport: server.transport,
    command: server.command,
    argsJson: JSON.stringify(server.args, null, 2),
    envJson: JSON.stringify(server.env, null, 2),
  };
}

function tokenizeCommandLine(line: string): string[] {
  if (/\r|\n/.test(line)) throw new Error('Enter one command only. Newlines are not supported.');
  const tokens: string[] = [];
  let current = '';
  let tokenStarted = false;
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let index = 0; index < line.length; index += 1) {
    const ch = line[index];
    if (escaped) {
      current += ch;
      tokenStarted = true;
      escaped = false;
      continue;
    }
    if (ch === '\\' && quote !== "'") {
      const next = line[index + 1];
      if (next === undefined) {
        escaped = true;
        tokenStarted = true;
        continue;
      }
      const escapesNext = /\s/.test(next)
        || next === '\\'
        || (!quote && (next === '"' || next === "'"))
        || next === quote;
      if (escapesNext) {
        escaped = true;
      } else {
        current += ch;
      }
      tokenStarted = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      tokenStarted = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      tokenStarted = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (tokenStarted) {
        tokens.push(current);
        current = '';
        tokenStarted = false;
      }
      continue;
    }
    if (';&|<>`'.includes(ch) || (ch === '$' && ['(', '{'].includes(line[index + 1] ?? ''))) {
      throw new Error('Shell operators and command substitution are not supported. Enter a command and its arguments only.');
    }
    current += ch;
    tokenStarted = true;
  }
  if (escaped) throw new Error('The command ends with an unfinished escape.');
  if (quote) throw new Error('The command has an unterminated quote.');
  if (tokenStarted) tokens.push(current);
  return tokens;
}

function inferNameFromTokens(command: string, args: string[]): string {
  const packageArg = args.find((arg) => !arg.startsWith('-')) ?? command;
  const withoutVersion = packageArg.startsWith('@')
    ? packageArg.replace(/@[^/]+$/, '')
    : packageArg.replace(/@[^@/]+$/, '');
  const base = (withoutVersion.split('/').pop() || command)
    .replace(/^(?:mcp[-_]?server|server[-_]?mcp|mcp|server)[-_]?/i, '')
    .replace(/[-_]?(?:mcp[-_]?server|server[-_]?mcp|mcp|server)$/i, '');
  const safe = base.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return safe || 'server';
}

/** Parse a single executable plus argv, or one HTTP(S) endpoint. */
export function parseMcpCommandOrUrlInput(raw: string): ParsedMcpConfig {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('Enter a command or URL first.');
  if (trimmed.startsWith('{')) throw new Error('Use Advanced JSON for config objects.');

  if (/^https?:/i.test(trimmed)) {
    const url = parseHttpUrl(trimmed, null);
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    const name = hostname.split('.')[0]?.replace(/[^A-Za-z0-9_-]+/g, '-') || 'remote';
    return { servers: [{ name, transport: 'http', command: url, args: [], env: {}, url }] };
  }

  const tokens = tokenizeCommandLine(trimmed);
  if (tokens.length === 0) throw new Error('Could not read that as a command.');
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) {
    throw new Error('Put environment variables in Advanced JSON so their values stay explicit.');
  }
  const command = tokens.shift()!;
  if (!command || command.startsWith('-')) throw new Error('The command must start with an executable name.');
  return {
    servers: [{
      name: inferNameFromTokens(command, tokens),
      transport: 'stdio',
      command,
      args: tokens,
      env: {},
    }],
  };
}

/** Backward-compatible dispatcher for callers that intentionally accept all forms. */
export function parseMcpAnyInput(raw: string): ParsedMcpConfig {
  return raw.trim().startsWith('{') ? parseMcpConfigInput(raw) : parseMcpCommandOrUrlInput(raw);
}
