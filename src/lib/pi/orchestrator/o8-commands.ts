import type { McpTool } from '@/lib/mcp/operator-handlers/shared';
import type { PiHostTool } from '@/lib/pi/sdk/session';

/** One JSON-RPC request to an o8 MCP server; resolves with its `result`. */
export type O8ServerRequest = (method: string, params: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;

/** An o8 MCP server as the Claude and Codex orchestrators see it: its name and a way to reach it. */
export interface O8CommandServer {
  name: string;
  request: O8ServerRequest;
}

export interface O8Command {
  /** The name Pi runs it by: the tool's own name, or `server.tool` when an earlier server lists the same name. */
  name: string;
  server: O8CommandServer;
  tool: McpTool;
}

/** Bounds what one command result adds to the model context. */
export const O8_COMMAND_OUTPUT_BYTES = 40_000;

/**
 * Every command the servers list, read the same way an MCP client reads them.
 * Claude sees each server's tools under that server's name, so a name listed by
 * two servers (the operator and cortex both list cortex_ask) stays two commands:
 * the later one is named `server.tool`.
 */
export async function listO8Commands(servers: O8CommandServer[], signal: AbortSignal): Promise<O8Command[]> {
  const commands = new Map<string, O8Command>();
  for (const server of servers) {
    const result = await server.request('tools/list', {}, signal) as { tools?: unknown } | undefined;
    if (!Array.isArray(result?.tools)) throw new Error(`The o8 ${server.name} server returned no command list`);
    for (const tool of result.tools as McpTool[]) {
      if (!tool || typeof tool.name !== 'string') continue;
      const name = commands.has(tool.name) ? `${server.name}.${tool.name}` : tool.name;
      if (!commands.has(name)) commands.set(name, { name, server, tool });
    }
  }
  return [...commands.values()];
}

function summary({ name, tool }: O8Command): string {
  const description = (tool.description ?? '').replace(/\s+/g, ' ').trim();
  const sentence = description.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? description;
  return `${name}: ${sentence.slice(0, 160)}`;
}

function capped(text: string): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= O8_COMMAND_OUTPUT_BYTES) return text;
  return `${bytes.subarray(0, O8_COMMAND_OUTPUT_BYTES).toString('utf8')}\n[Output truncated after ${O8_COMMAND_OUTPUT_BYTES} bytes.]`;
}

function text(value: string) {
  return { content: [{ type: 'text' as const, text: value }] };
}

/**
 * Exposes every o8 command through three tools instead of one schema per
 * command. The operator server alone lists 125 commands and about 110 KB of
 * schemas, which would ride on every model call; here the model looks a command
 * up when it needs it. Calls go to the servers unchanged, so their own checks
 * apply as they do for every other orchestrator.
 */
export function createO8CommandTools(commands: O8Command[]): PiHostTool[] {
  const byName = new Map(commands.map(command => [command.name, command]));
  return [
    {
      definition: {
        name: 'o8_commands',
        description: 'List o8 commands with a one-line summary each. Pass query to filter by name or description.',
        parameters: { type: 'object', properties: { query: { type: 'string' } }, additionalProperties: false },
      },
      async execute(args) {
        const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
        const matches = commands.filter(({ name, tool }) => !query
          || name.toLowerCase().includes(query) || (tool.description ?? '').toLowerCase().includes(query));
        return text(matches.length ? matches.map(summary).join('\n') : `No o8 command matches "${query}".`);
      },
    },
    {
      definition: {
        name: 'o8_command_help',
        description: 'Show one o8 command\'s full description and argument schema. Read it before running a command for the first time.',
        parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false },
      },
      async execute(args) {
        const command = typeof args.name === 'string' ? byName.get(args.name) : undefined;
        if (!command) return text(`Unknown o8 command: ${String(args.name)}. Use o8_commands to list them.`);
        const { description, inputSchema } = command.tool;
        return text(capped(JSON.stringify({ name: command.name, description, arguments: inputSchema }, null, 2)));
      },
    },
    {
      definition: {
        name: 'o8_run',
        description: 'Run one o8 command. Pass its arguments as a JSON object string, exactly as its schema in o8_command_help defines them.',
        parameters: {
          type: 'object',
          // A string, not a free-form object: some providers reject object
          // parameters that declare no properties.
          properties: {
            name: { type: 'string' },
            arguments: { type: 'string', description: 'JSON object, for example {"missionId":"m-1"}' },
          },
          required: ['name'],
          additionalProperties: false,
        },
      },
      async execute(args, signal) {
        const name = typeof args.name === 'string' ? args.name : '';
        const command = byName.get(name);
        if (!command) return text(`Unknown o8 command: ${name || '(none)'}. Use o8_commands to list them.`);
        let commandArgs: unknown = args.arguments ?? {};
        if (typeof commandArgs === 'string') {
          try { commandArgs = commandArgs.trim() ? JSON.parse(commandArgs) : {}; } catch { commandArgs = null; }
        }
        if (!commandArgs || typeof commandArgs !== 'object' || Array.isArray(commandArgs)) {
          return text('The arguments for an o8 command must be a JSON object.');
        }
        let result: { content?: Array<{ type?: string; text?: string }>; isError?: boolean } | undefined;
        try {
          result = await command.server.request('tools/call', { name: command.tool.name, arguments: commandArgs }, signal) as typeof result;
        } catch (error) {
          signal.throwIfAborted();
          // Transport errors can carry server stderr; they stay in the host log.
          console.warn(`[pi-orchestrator] o8 command ${name} failed:`, error);
          return text(`o8 command ${name} could not reach the o8 ${command.server.name} server.`);
        }
        const output = (result?.content ?? [])
          .map(part => (part.type === 'text' && typeof part.text === 'string' ? part.text : `[${part.type ?? 'unknown'} content omitted]`))
          .join('\n');
        return text(capped(result?.isError ? `o8 command ${name} returned an error:\n${output}` : output || '(no output)'));
      },
    },
  ];
}

/** Names every command once, so the model knows what exists before it looks one up. */
export function o8CommandPrompt(commands: O8Command[]): string {
  return [
    '## o8 commands in this session',
    'Every o8 MCP tool named in these instructions is an o8 command here. Run one with o8_run,',
    'passing its name and its arguments as a JSON object string. Read o8_command_help for a command',
    'before its first use, and use o8_commands to search. Never claim a command ran unless o8_run',
    'returned its result.',
    `Commands: ${commands.map(({ name }) => name).join(', ')}.`,
  ].join('\n');
}
