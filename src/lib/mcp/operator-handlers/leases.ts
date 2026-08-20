import { randomUUID } from 'node:crypto';

import {
  apiFetch,
  errorText,
  jsonResult,
  requiredString,
  textResult,
  type McpTool,
  type McpToolResult,
} from './shared';

const WAIT_POLL_MS = 100;

export const LEASE_TOOLS: McpTool[] = [
  {
    name: 'o8_lease_acquire',
    description: 'Acquire one named resource lease. With wait:true, remain queued in durable FIFO order until ownership is granted or this MCP process exits.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        resource: { type: 'string', minLength: 1, maxLength: 2048 },
        ttlMs: { type: 'integer', minimum: 1000, maximum: 86400000 },
        wait: { type: 'boolean' },
      },
      required: ['resource'],
    },
  },
  {
    name: 'o8_lease_release',
    description: 'Release a named resource only when this exact MCP process is its current holder.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { resource: { type: 'string', minLength: 1, maxLength: 2048 } },
      required: ['resource'],
    },
  },
  {
    name: 'o8_lease_status',
    description: 'Read the current holder, overdue state, fail-closed blocker, and FIFO waiters for one named resource.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { resource: { type: 'string', minLength: 1, maxLength: 2048 } },
      required: ['resource'],
    },
  },
  {
    name: 'o8_lease_list',
    description: 'List every active named resource holder and waiter queue.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
      required: [],
    },
  },
];

function owner() {
  return {
    id: `mcp:${process.pid}`,
    label: `mcp-agent:${process.pid}`,
    pid: process.pid,
  };
}

function optionalTtl(args: Record<string, unknown>): number | undefined {
  const value = args.ttlMs;
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < 1_000 || Number(value) > 86_400_000) {
    throw new Error('ttlMs must be an integer from 1000 through 86400000.');
  }
  return Number(value);
}

function sleep(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
}

export async function handleLeaseAcquire(args: Record<string, unknown>): Promise<McpToolResult> {
  const resource = requiredString(args, 'resource');
  const wait = args.wait === true;
  const leaseOwner = owner();
  const waiterId = `waiter:mcp:${process.pid}:${randomUUID()}`;
  try {
    for (;;) {
      const data = await apiFetch('/api/leases', {
        method: 'POST',
        body: JSON.stringify({
          action: 'acquire',
          resource,
          owner: leaseOwner,
          waiterPid: wait ? process.pid : undefined,
          ttlMs: optionalTtl(args),
          wait,
          waiterId,
        }),
        acceptedErrorStatuses: [409],
      }) as { result?: { state?: string } };
      const state = data.result?.state;
      if (state === 'acquired') return jsonResult(data);
      if (state === 'refused' || !wait) {
        return textResult(JSON.stringify(data), true);
      }
      if (state !== 'queued') {
        return textResult('o8_lease_acquire failed: backend returned no recognized lease state.', true);
      }
      await sleep();
    }
  } catch (error) {
    return textResult(`o8_lease_acquire failed: ${errorText(error)}`, true);
  }
}

export async function handleLeaseRelease(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const data = await apiFetch('/api/leases', {
      method: 'POST',
      body: JSON.stringify({
        action: 'release',
        resource: requiredString(args, 'resource'),
        owner: owner(),
      }),
      acceptedErrorStatuses: [404, 409],
    }) as { ok?: boolean };
    return data.ok ? jsonResult(data) : textResult(JSON.stringify(data), true);
  } catch (error) {
    return textResult(`o8_lease_release failed: ${errorText(error)}`, true);
  }
}

export async function handleLeaseStatus(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const resource = encodeURIComponent(requiredString(args, 'resource'));
    return jsonResult(await apiFetch(`/api/leases?resource=${resource}`));
  } catch (error) {
    return textResult(`o8_lease_status failed: ${errorText(error)}`, true);
  }
}

export async function handleLeaseList(): Promise<McpToolResult> {
  try {
    return jsonResult(await apiFetch('/api/leases'));
  } catch (error) {
    return textResult(`o8_lease_list failed: ${errorText(error)}`, true);
  }
}
