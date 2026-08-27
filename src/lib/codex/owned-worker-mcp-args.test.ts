import { describe, expect, it } from 'vitest';

import { codexWorkerMcpOverrideArgs } from './owned';

describe('codexWorkerMcpOverrideArgs', () => {
  it('encodes strings, arrays, and quoted inline-table env keys as TOML overrides', () => {
    expect(codexWorkerMcpOverrideArgs([
      {
        id: 'server-valid',
        name: 'packet-observer',
        command: '/tmp/MCP "server"\\bin',
        args: ['quote "this"', 'C:\\tools\\mcp'],
        env: {
          'API KEY': 'value "quoted"',
          WINDOWS_PATH: 'C:\\Users\\worker',
        },
      },
      {
        id: 'server-invalid',
        name: 'bad name',
        command: '/usr/bin/false',
        args: [],
        env: null,
      },
    ])).toEqual([
      '-c', 'mcp_servers.packet-observer.command="/tmp/MCP \\"server\\"\\\\bin"',
      '-c', 'mcp_servers.packet-observer.args=["quote \\"this\\"", "C:\\\\tools\\\\mcp"]',
      '-c', 'mcp_servers.packet-observer.env={"API KEY"="value \\"quoted\\"", "WINDOWS_PATH"="C:\\\\Users\\\\worker"}',
    ]);
  });
});
