import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { O8WebviewClient } from './o8-webview-client';
import { createO8WebviewToolHandlers, O8_WEBVIEW_TOOLS } from './o8-webview-tools';

describe('discoverable directory dialog control', () => {
  it('exports strict schemas and refuses invalid arguments before connecting', async () => {
    const handlers = createO8WebviewToolHandlers(() => { throw new Error('must not connect'); });
    for (const name of ['o8_view_inspect_directory_dialog', 'o8_view_resolve_directory_dialog']) {
      const tool = O8_WEBVIEW_TOOLS.find((entry) => entry.name === name);
      expect(tool?.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
      expect(JSON.stringify(tool?.inputSchema)).not.toMatch(/oneOf|anyOf|allOf/);
      expect(typeof handlers[name]).toBe('function');
    }
    for (const args of [
      { dialog_id: 'id', operation: 'select', path: 'relative' },
      { dialog_id: 'id', operation: 'select', path: '/tmp/\0bad' },
      { dialog_id: 'id', operation: 'cancel', path: '/tmp' },
      { dialog_id: 1, operation: 'cancel' },
      { dialog_id: 'id', operation: 'click' },
      { dialog_id: 'id', operation: 'cancel', window_label: 'dock' },
    ]) {
      const result = await handlers.o8_view_resolve_directory_dialog(args);
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain('must not connect');
    }
  });

  const directories: string[] = [];
  afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

  it('uses authenticated client socket transport and never reconnect-replays resolve', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'o8-dialog-agent-'));
    directories.push(directory);
    const socketPath = join(directory, 'app.sock');
    writeFileSync(`${socketPath}.token`, 'fixture-auth');
    const previousSocket = process.env.O8_TAURI_MCP_SOCKET;
    const previousToken = process.env.TAURI_MCP_AUTH_TOKEN;
    process.env.O8_TAURI_MCP_SOCKET = socketPath;
    delete process.env.TAURI_MCP_AUTH_TOKEN;
    const requests: Array<Record<string, unknown>> = [];
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString();
        let newline: number;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const request = JSON.parse(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          requests.push(request);
          expect(request.authToken).toBe('fixture-auth');
          expect(typeof request.id).toBe('string');
          if (request.command === 'inspect_directory_dialog') {
            socket.write(JSON.stringify({ id: request.id, success: true, data: { dialog_id: 'live', status: 'live' } }) + '\n');
          } else if (request.payload.dialog_id === 'old') {
            socket.write(JSON.stringify({ id: request.id, success: false, error: 'stale_dialog', data: { code: 'stale_dialog' } }) + '\n');
          } else if (request.payload.operation === 'select') {
            socket.write(JSON.stringify({ id: request.id, success: false, error: 'selection_not_supported', data: { code: 'selection_not_supported' } }) + '\n');
          } else {
            socket.destroy(); // Unknown mutation outcome after its authenticated write.
          }
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const client = new O8WebviewClient();
    try {
      const handlers = createO8WebviewToolHandlers(() => client);
      const inspection = await handlers.o8_view_inspect_directory_dialog({});
      expect(JSON.stringify(inspection)).toContain('live');
      expect(requests[0].payload).toEqual({});
      const stale = await handlers.o8_view_resolve_directory_dialog({ dialog_id: 'old', operation: 'cancel' });
      expect(stale.isError).toBe(true);
      expect(JSON.stringify(stale)).toContain('stale_dialog');
      const refused = await handlers.o8_view_resolve_directory_dialog({ dialog_id: 'live', operation: 'select', path: directory });
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused)).toContain('selection_not_supported');
      const dropped = await handlers.o8_view_resolve_directory_dialog({ dialog_id: 'live', operation: 'cancel', path: null });
      expect(dropped.isError).toBe(true);
      expect(JSON.stringify(dropped)).toContain('not retried automatically');
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(requests.filter((entry) => entry.command === 'resolve_directory_dialog')).toHaveLength(3);
      expect(requests[2].payload).toEqual({ dialog_id: 'live', operation: 'select', path: directory });
      expect(requests[3].payload).toEqual({ dialog_id: 'live', operation: 'cancel' });
    } finally {
      client.dispose();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (previousSocket === undefined) delete process.env.O8_TAURI_MCP_SOCKET;
      else process.env.O8_TAURI_MCP_SOCKET = previousSocket;
      if (previousToken === undefined) delete process.env.TAURI_MCP_AUTH_TOKEN;
      else process.env.TAURI_MCP_AUTH_TOKEN = previousToken;
    }
  });
});
