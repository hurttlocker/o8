/**
 * Cortex read-only profile (Collide proposer / #1075) — STRUCTURAL proof at the
 * real server. Spawns cortex-mcp-server.ts with CORTEX_READONLY=1, drives the
 * stdio JSON-RPC, and asserts:
 *   - tools/list advertises ONLY the 9 allowlisted read tools — cortex_launch_agent
 *     and every other mutator are absent from the proposer's surface;
 *   - tools/call cortex_launch_agent is REJECTED (fail-closed) without dispatching;
 *   - control: WITHOUT the flag, cortex_launch_agent IS advertised.
 *
 *   CORTEX_IDE_DATA_DIR=$(mktemp -d) NODE_OPTIONS='--conditions=react-server' \
 *     npx tsx tests/smoke/cortex-readonly-profile-smoke.ts
 */

import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

import './require-temp-data-dir';
const SERVER = join(process.cwd(), 'src/lib/mcp/cortex-mcp-server.ts');
const READONLY_EXPECTED = [
  'cortex_ask', 'cortex_read_packets', 'cortex_read_transcript', 'cortex_fleet_status',
  'cortex_list_approvals', 'cortex_list_issues', 'cortex_list_prs', 'cortex_list_projects', 'cortex_ci_status',
].sort();

interface Rpc { id: number; method: string; params?: unknown }

function driveServer(readonly: boolean, requests: Rpc[]): Promise<Map<number, Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['tsx', SERVER], {
      env: { ...process.env, ...(readonly ? { CORTEX_READONLY: '1' } : {}), NODE_OPTIONS: '--conditions=react-server' },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    const responses = new Map<number, Record<string, unknown>>();
    const rl = createInterface({ input: child.stdout });
    const watchdog = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('cortex server smoke timed out')); }, 30000);

    rl.on('line', (line) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(line); } catch { return; } // skip non-JSON log noise
      if (typeof msg.id === 'number') {
        responses.set(msg.id, msg);
        if (msg.id === requests[requests.length - 1].id) {
          clearTimeout(watchdog);
          child.kill('SIGTERM');
          resolve(responses);
        }
      }
    });
    child.on('error', reject);
    for (const req of requests) child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...req })}\n`);
  });
}

function toolNames(listResponse: Record<string, unknown> | undefined): string[] {
  const result = (listResponse?.result ?? {}) as { tools?: Array<{ name: string }> };
  return (result.tools ?? []).map((t) => t.name);
}

function toolSchema(
  listResponse: Record<string, unknown> | undefined,
  name: string,
): Record<string, unknown> {
  const result = (listResponse?.result ?? {}) as {
    tools?: Array<{ name: string; inputSchema?: Record<string, unknown> }>;
  };
  return result.tools?.find((tool) => tool.name === name)?.inputSchema ?? {};
}

async function main(): Promise<void> {
  const reqs: Rpc[] = [
    { id: 1, method: 'initialize', params: {} },
    { id: 2, method: 'tools/list' },
    { id: 3, method: 'tools/call', params: { name: 'cortex_launch_agent', arguments: { task: 'go' } } },
  ];

  // ── Read-only profile.
  const ro = await driveServer(true, reqs);
  const roTools = toolNames(ro.get(2)).sort();
  assert.deepStrictEqual(roTools, READONLY_EXPECTED, `read-only tools/list must be exactly the 9 reads; got ${roTools.join(', ')}`);
  assert(!roTools.includes('cortex_launch_agent'), 'cortex_launch_agent ABSENT from read-only surface');
  const callRes = (ro.get(3)?.result ?? {}) as { isError?: boolean; content?: Array<{ text?: string }> };
  assert(callRes.isError === true, 'tools/call cortex_launch_agent is rejected in read-only mode');
  assert(/read-only/i.test(callRes.content?.[0]?.text ?? ''), 'rejection cites read-only mode');

  // ── Control: full profile advertises the dispatch tool.
  const full = await driveServer(false, [{ id: 1, method: 'initialize', params: {} }, { id: 2, method: 'tools/list' }]);
  assert(toolNames(full.get(2)).includes('cortex_launch_agent'), 'full profile DOES advertise cortex_launch_agent (control)');
  const launchSchema = toolSchema(full.get(2), 'cortex_launch_agent') as {
    properties?: Record<string, unknown>;
  };
  assert(launchSchema.properties?.runtime, 'cortex_launch_agent advertises runtime override');
  assert(launchSchema.properties?.model, 'cortex_launch_agent advertises model override');
  assert(launchSchema.properties?.workerIntent, 'cortex_launch_agent advertises worker intent');

  console.log(`[cortex-readonly-profile-smoke] PASS — read-only advertises only ${roTools.length} reads, blocks cortex_launch_agent; full advertises it`);
}

void main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
