import { describe, expect, it } from 'vitest';

import {
  parseMcpCommandOrUrlInput,
  parseMcpConfigInput,
} from './parse-config';

describe('MCP setup input parsing', () => {
  it('parses an executable into exact argv without shell evaluation', () => {
    const { servers } = parseMcpCommandOrUrlInput(
      String.raw`npx -y @modelcontextprotocol/server-filesystem@latest "/path with spaces" '' escaped\ value`,
    );

    expect(servers).toEqual([{
      name: 'filesystem',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem@latest', '/path with spaces', '', 'escaped value'],
      env: {},
    }]);
  });

  it('preserves ordinary backslashes in quoted Windows paths and regex arguments', () => {
    const { servers } = parseMcpCommandOrUrlInput(
      String.raw`npx package "C:\Users\Example\mcp server" "\d+\s+value"`,
    );

    expect(servers[0]?.args).toEqual([
      'package',
      String.raw`C:\Users\Example\mcp server`,
      String.raw`\d+\s+value`,
    ]);
  });

  it('parses the Settings example command with a quoted folder', () => {
    expect(parseMcpCommandOrUrlInput(
      'npx -y @modelcontextprotocol/server-filesystem "/tmp/example folder"',
    ).servers[0]).toMatchObject({
      name: 'filesystem',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp/example folder'],
    });
  });

  it.each([
    ['unterminated quote', 'npx "package', 'unterminated quote'],
    ['unfinished escape', 'npx package\\', 'unfinished escape'],
    ['newline', 'npx package\nother', 'Newlines are not supported'],
    ['operator', 'npx package && other', 'Shell operators'],
    ['substitution', 'npx package $(other)', 'command substitution'],
    ['env prefix', 'TOKEN=secret npx package', 'Advanced JSON'],
  ])('rejects %s syntax', (_label, input, message) => {
    expect(() => parseMcpCommandOrUrlInput(input)).toThrow(message);
  });

  it('accepts only complete HTTP(S) URLs', () => {
    expect(parseMcpCommandOrUrlInput('https://mcp.example.com/rpc').servers[0]).toMatchObject({
      name: 'mcp',
      transport: 'http',
      command: 'https://mcp.example.com/rpc',
      url: 'https://mcp.example.com/rpc',
    });
    expect(() => parseMcpCommandOrUrlInput('https:// bad')).toThrow('invalid URL');
  });

  it('preserves supported JSON argv and env values exactly', () => {
    const { servers } = parseMcpConfigInput(JSON.stringify({
      mcpServers: {
        filesystem: {
          command: 'npx',
          args: ['-y', '', ' value with edges '],
          env: { API_TOKEN: '  secret value  ' },
        },
      },
    }));

    expect(servers[0]).toEqual({
      name: 'filesystem',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '', ' value with edges '],
      env: { API_TOKEN: '  secret value  ' },
    });
  });

  it('parses every supported server in wrapped JSON', () => {
    const { servers } = parseMcpConfigInput(JSON.stringify({
      mcpServers: {
        local: { command: 'node', args: ['server.js'] },
        remote: { type: 'http', url: 'https://mcp.example.com/rpc' },
      },
    }));
    expect(servers.map((server) => [server.name, server.transport])).toEqual([
      ['local', 'stdio'],
      ['remote', 'http'],
    ]);
  });

  it.each([
    [{ command: 'npx', args: ['pkg'], headers: { Authorization: 'Bearer secret' } }, 'headers'],
    [{ type: 'http', url: 'https://mcp.example.com', env: { TOKEN: 'secret' } }, 'env'],
    [{ command: 'npx', args: [3] }, 'array of strings'],
    [{ command: 'npx', env: { TOKEN: 3 } }, 'string values'],
  ])('rejects unsupported or lossy JSON instead of dropping it', (entry, message) => {
    expect(() => parseMcpConfigInput(JSON.stringify(entry))).toThrow(message);
  });

  it('rejects unknown top-level wrapper fields', () => {
    expect(() => parseMcpConfigInput(JSON.stringify({
      mcpServers: { local: { command: 'node' } },
      metadata: { owner: 'operator' },
    }))).toThrow('metadata');
  });
});
