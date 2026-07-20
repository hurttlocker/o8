#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { DEFAULT_API_PORT } from '@/lib/panel/api-port';

type JsonRpcId = number | string | null;

function getDataDir(): string {
  return process.env.CORTEX_IDE_DATA_DIR || join(homedir(), '.o8');
}

function readTrimmed(path: string): string {
  try { return existsSync(path) ? readFileSync(path, 'utf-8').trim() : ''; } catch { return ''; }
}

function resolveApiBase(): string {
  const portText = readTrimmed(join(getDataDir(), 'api-port'));
  const port = Number(portText);
  if (Number.isInteger(port) && port > 0 && port < 65536) return `http://127.0.0.1:${port}`;
  if (process.env.O8_API_BASE) return process.env.O8_API_BASE;
  if (process.env.O8_API_PORT) return `http://127.0.0.1:${process.env.O8_API_PORT}`;
  return `http://127.0.0.1:${DEFAULT_API_PORT}`;
}

function requestId(message: unknown): JsonRpcId {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
  const id = (message as { id?: unknown }).id;
  return typeof id === 'number' || typeof id === 'string' || id === null ? id : null;
}

function expectsResponse(message: unknown): boolean {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return true;
  const id = (message as { id?: unknown }).id;
  return id !== undefined && id !== null;
}

function send(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function forward(message: unknown): Promise<void> {
  const token = readTrimmed(join(getDataDir(), 'ws-token'));
  const response = await fetch(`${resolveApiBase()}/api/mcp`, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(message),
  });

  if (response.status === 202) return;
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`o8 MCP host returned HTTP ${response.status}${text ? `: ${text.slice(0, 300)}` : ''}`);
  }
  if (text.trim()) send(JSON.parse(text));
}

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  void forward(message).catch((error) => {
    if (!expectsResponse(message)) return;
    send({
      jsonrpc: '2.0',
      id: requestId(message),
      error: {
        code: -32001,
        message: `o8 app MCP host unavailable: ${error instanceof Error ? error.message : String(error)}`,
      },
    });
  });
});
rl.on('close', () => process.exit(0));
