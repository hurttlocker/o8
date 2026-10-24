import { describe, expect, it, vi } from 'vitest';
import { deferredMcpRequest } from './deferred-tools';

const tools = [{ name: 'o8_status', description: 'Status.', inputSchema: { type: 'object' } },
  { name: 'read_preview', description: 'Read a preview image.', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } }];
const request = (name: string, args: unknown) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });

describe('portable deferred MCP facade', () => {
  it('leaves full loading, notifications and ordinary calls untouched without reading the catalog', async () => {
    const list = vi.fn(() => tools);
    const ordinary = request('read_preview', { id: 'preview' });
    expect(await deferredMcpRequest(ordinary, list, true)).toEqual({ message: ordinary });
    const listing = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
    expect(await deferredMcpRequest(listing, list, false)).toEqual({ message: listing });
    const notification = { method: 'notifications/initialized' };
    expect(await deferredMcpRequest(notification, list, true)).toEqual({ message: notification });
    expect(list).not.toHaveBeenCalled();
  });

  it('keeps the core small, returns intact schemas and unwraps calls without altering arguments', async () => {
    const initial = await deferredMcpRequest({ id: 1, method: 'tools/list' }, () => tools, true);
    expect(initial.response?.result).toEqual({ tools: [tools[0], expect.objectContaining({ name: 'o8_tool_search' }), expect.objectContaining({ name: 'o8_tool_call' })] });
    const result = await deferredMcpRequest(request('o8_tool_search', { query: 'read_preview' }), () => tools, true);
    expect(result.response?.result).toMatchObject({ content: [{ text: JSON.stringify({ tools: [tools[1]], total: 1, nextOffset: null }) }] });
    expect(await deferredMcpRequest(request('o8_tool_call', { name: 'read_preview', arguments: '{"id":"🌱","nested":{"x":1}}' }), () => tools, true))
      .toEqual({ message: request('read_preview', { id: '🌱', nested: { x: 1 } }) });
  });

  it.each(['{', '[]', 'null', '42'])('rejects invalid argument JSON %s before forwarding', async (args) => {
    const result = await deferredMcpRequest(request('o8_tool_call', { name: 'read_preview', arguments: args }), () => tools, true);
    expect(result.response?.result).toMatchObject({ isError: true });
  });

  it.each([{ query: '' , limit: 0 }, { query: '', offset: -1 }, { query: '', limit: 11 }, { query: 'x'.repeat(513) }, null])
    ('rejects invalid search arguments %j', async (args) => {
      const result = await deferredMcpRequest(request('o8_tool_search', args), () => tools, true);
      expect(result.response?.result).toMatchObject({ isError: true });
    });

  it('rejects absent and recursive tools using the current catalog', async () => {
    for (const name of ['hidden', 'o8_tool_call', 'o8_tool_search']) {
      const result = await deferredMcpRequest(request('o8_tool_call', { name, arguments: '{}' }), () => tools, true);
      expect(result.response?.result).toMatchObject({ isError: true });
    }
    const list = vi.fn(() => tools);
    await deferredMcpRequest(request('o8_tool_search', { query: 'preview' }), list, true);
    list.mockReturnValue([]);
    const result = await deferredMcpRequest(request('o8_tool_call', { name: 'read_preview', arguments: '{}' }), list, true);
    expect(result.response?.result).toMatchObject({ isError: true });
  });
});
