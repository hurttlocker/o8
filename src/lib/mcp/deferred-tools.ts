import type { McpTool } from '@/lib/mcp/operator-handlers/shared';

interface Request {
  jsonrpc?: string;
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

const CORE_TOOLS = new Set(['o8_status', 'o8_send', 'cortex_fleet_status']);
const SEARCH: McpTool = {
  name: 'o8_tool_search',
  description: 'Find o8 tools by name or keywords. Returns complete descriptions and argument schemas. Use an empty query and nextOffset to enumerate every tool. Call discovered tools with o8_tool_call.',
  inputSchema: { type: 'object', properties: {
    query: { type: 'string' },
    offset: { type: 'integer', minimum: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 10 },
  }, required: ['query'], additionalProperties: false },
};
const CALL: McpTool = {
  name: 'o8_tool_call',
  description: 'Call a tool discovered with o8_tool_search on this server. Read its schema first. Pass the tool name and arguments as a JSON object string. Returns the original tool result, including errors and images.',
  inputSchema: { type: 'object', properties: {
    name: { type: 'string' },
    arguments: { type: 'string', description: 'JSON object matching the discovered inputSchema, for example {"name":"Example"}.' },
  }, required: ['name', 'arguments'], additionalProperties: false },
};

/** Static MCP indirection, like Pi's command bridge; no native runtime search extension required. */
export async function deferredMcpRequest<T extends Request>(
  message: T,
  list: () => Promise<McpTool[]> | McpTool[],
  enabled = process.env.O8_MCP_TOOL_LOADING === 'deferred',
): Promise<{ message: T; response?: never } | { response: { jsonrpc: '2.0'; id: string | number; result: unknown }; message?: never }> {
  if (!enabled || message.id === undefined || message.id === null) return { message };
  const reply = (result: unknown) => ({ response: { jsonrpc: '2.0' as const, id: message.id as string | number, result } });
  const text = (value: unknown, isError = false) => reply({ content: [{ type: 'text', text: JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}) });
  if (message.method === 'tools/list') {
    const tools = await list();
    return reply({ tools: [...tools.filter(tool => CORE_TOOLS.has(tool.name)), SEARCH, CALL] });
  }
  if (message.method !== 'tools/call') return { message };
  const name = message.params?.name;
  if (name !== SEARCH.name && name !== CALL.name) return { message };
  const args = message.params?.arguments;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return text('Expected an arguments object.', true);
  const input = args as Record<string, unknown>;
  if (name === SEARCH.name) {
    const { query, offset = 0, limit = 5 } = input;
    if (typeof query !== 'string' || query.length > 512 || !Number.isSafeInteger(offset) || (offset as number) < 0
      || !Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 10) {
      return text('Use a query of at most 512 characters, a non-negative integer offset and a limit from 1 to 10.', true);
    }
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const matches = (await list()).map((tool, index) => {
      const toolName = tool.name.toLowerCase();
      const description = tool.description.toLowerCase();
      const score = terms.reduce((value, term) => value + (toolName === term ? 100 : toolName.includes(term) ? 10 : description.includes(term) ? 1 : 0), 0);
      return { tool, index, score };
    }).filter(entry => terms.length === 0 || entry.score > 0)
      .sort((left, right) => right.score - left.score || left.index - right.index);
    const end = (offset as number) + (limit as number);
    return text({ tools: matches.slice(offset as number, end).map(entry => entry.tool), total: matches.length,
      nextOffset: end < matches.length ? end : null });
  }
  if (typeof input.name !== 'string' || typeof input.arguments !== 'string') {
    return text('Pass a tool name and its arguments as a JSON object string.', true);
  }
  let toolArgs: unknown;
  try { toolArgs = JSON.parse(input.arguments); } catch { return text('Tool arguments must be valid JSON.', true); }
  if (!toolArgs || typeof toolArgs !== 'object' || Array.isArray(toolArgs)) return text('Tool arguments must be a JSON object.', true);
  // Discover from the current, already-filtered catalog. Never expand a profile,
  // cache an earlier principal's catalog or forward recursively to this bridge.
  if (input.name === SEARCH.name || input.name === CALL.name || !(await list()).some(tool => tool.name === input.name)) {
    return text('Tool unavailable. Use o8_tool_search for tools in this session.', true);
  }
  return { message: { ...message, params: { ...message.params, name: input.name, arguments: toolArgs } } };
}
