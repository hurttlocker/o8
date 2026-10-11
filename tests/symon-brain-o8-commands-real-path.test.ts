import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { SymonBrain } from '@/lib/symon/durable/brain';
import type { O8ServerSet } from '@/lib/pi/orchestrator/o8-servers';

const opened = vi.hoisted(() => ({ profiles: [] as unknown[] }));
vi.mock('@/lib/pi/orchestrator/o8-servers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/pi/orchestrator/o8-servers')>();
  return {
    ...actual,
    openO8Servers: async (_repoPath: string, options: { profile?: unknown }) => {
      opened.profiles.push(options.profile);
      return { servers: [], close: async () => {} };
    },
  };
});

let root: string;
const brains: SymonBrain[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'o8-symon-o8-tools-'));
  opened.profiles = [];
});

afterEach(async () => {
  await Promise.all(brains.splice(0).map((brain) => brain.close().catch(() => {})));
  rmSync(root, { recursive: true, force: true });
});

/** A read-only cortex double: one fleet command, counted calls, an optional gate on calls. */
function fakeServers(options: { gate?: Promise<void> } = {}) {
  const calls: Array<{ name: string; args: unknown }> = [];
  let opens = 0;
  let closes = 0;
  const open = async (): Promise<O8ServerSet> => {
    opens += 1;
    return {
      servers: [{
        name: 'cortex',
        request: async (method, params, signal) => {
          if (method === 'tools/list') {
            return { tools: [{ name: 'cortex_fleet_status', description: 'Show what the fleet is doing.', inputSchema: { type: 'object', properties: {} } }] };
          }
          calls.push({ name: String(params.name), args: params.arguments });
          if (options.gate) {
            await new Promise<void>((resolve, reject) => {
              options.gate!.then(resolve);
              signal.addEventListener('abort', () => reject(new Error('Stopped')), { once: true });
            });
          }
          return { content: [{ type: 'text', text: '2 packets running, 1 waiting for review' }] };
        },
      }],
      close: async () => { closes += 1; },
    };
  };
  return { open, calls, opens: () => opens, closes: () => closes };
}

async function brainWith(servers: ReturnType<typeof fakeServers>, faux = fauxProvider(), idleMs?: number, path = join(root, 'symon.sqlite')) {
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const brain = await SymonBrain.open({
    storagePath: path, models, model: { provider: model.provider, modelId: model.id },
    o8Servers: servers.open, o8ServersIdleMs: idleMs,
  });
  brains.push(brain);
  return { brain, faux };
}

const thread = { key: 'phone:session-1', source: 'phone' as const, title: 'Phone' };
const runFleet = fauxAssistantMessage([fauxToolCall('o8_run', { name: 'cortex_fleet_status', arguments: '{}' })], { stopReason: 'toolUse' });

describe('durable Symon brain with read-only o8 commands (#3474)', () => {
  it('runs a read-only o8 command and answers from its result', async () => {
    const servers = fakeServers();
    const { brain, faux } = await brainWith(servers);
    const toolResults: string[] = [];
    faux.setResponses([
      runFleet,
      (context) => {
        toolResults.push(JSON.stringify(context.messages.at(-1)));
        return fauxAssistantMessage([fauxText('Two packets are running and one is waiting for review.')]);
      },
    ]);

    const outcome = await brain.send({ ...thread, requestId: 'r1', text: 'What is o8 doing?' }, 10_000);

    expect(outcome).toEqual({ state: 'done', text: 'Two packets are running and one is waiting for review.' });
    expect(servers.calls).toEqual([{ name: 'cortex_fleet_status', args: {} }]);
    expect(toolResults[0]).toContain('2 packets running');
  });

  it('offers the catalog tools and tells the model they only read', async () => {
    const servers = fakeServers();
    const { brain, faux } = await brainWith(servers);
    let offered: string[] = [];
    let system = '';
    faux.setResponses([(context) => {
      // Tools arrive on system messages, with the prompt sections.
      offered = context.messages
        .flatMap((message) => (message.role === 'system' ? message.toolsAdded ?? [] : []))
        .map((tool) => tool.name).sort();
      system = JSON.stringify(context.messages[0]);
      return fauxAssistantMessage('Hello.');
    }]);

    await brain.send({ ...thread, requestId: 'r2', text: 'Hi' }, 10_000);

    expect(offered).toEqual(['o8_command_help', 'o8_commands', 'o8_run']);
    expect(system).toContain('These commands only read');
    // Nothing opens until a command is used.
    expect(servers.opens()).toBe(0);
  });

  it('opens the read-only proposer projection in production', async () => {
    const { openReadOnlyO8Servers } = await import('@/lib/symon/durable/o8-tools');
    await openReadOnlyO8Servers();
    expect(opened.profiles).toEqual(['propose']);
    const { buildToolRegistry } = await import('@/lib/mcp/tool-spine/build');
    const { entriesForSurface } = await import('@/lib/mcp/tool-spine/registry');
    const ids = entriesForSurface(buildToolRegistry(root, { profile: 'propose' }), 'claude-orchestrator').map(({ entry }) => entry.id);
    expect(ids).not.toContain('builtin:operator');
  });

  it('reports an interrupted command after a restart and never runs it again', async () => {
    const path = join(root, 'restart.sqlite');
    const firstServers = fakeServers({ gate: new Promise<void>(() => {}) });
    const firstFaux = fauxProvider();
    firstFaux.setResponses([runFleet]);
    const { brain: first } = await brainWith(firstServers, firstFaux, undefined, path);

    expect(await first.send({ ...thread, requestId: 'r3', text: 'Fleet?' }, 500)).toEqual({ state: 'pending' });
    await vi.waitFor(() => expect(firstServers.calls).toHaveLength(1));
    await first.close();
    brains.splice(brains.indexOf(first), 1);

    const secondServers = fakeServers();
    const secondFaux = fauxProvider();
    const seen: string[] = [];
    secondFaux.setResponses([(context) => {
      seen.push(JSON.stringify(context.messages.at(-1)));
      return fauxAssistantMessage('I could not finish checking the fleet. Ask me again.');
    }]);
    const { brain: second } = await brainWith(secondServers, secondFaux, undefined, path);

    expect(await second.send({ ...thread, requestId: 'r3', text: 'Fleet?' }, 10_000))
      .toEqual({ state: 'done', text: 'I could not finish checking the fleet. Ask me again.' });
    expect(secondServers.calls).toHaveLength(0);
    expect(seen[0]).toMatch(/interrupt/i);
  });

  it('closes idle servers and reopens them on the next command', async () => {
    const servers = fakeServers();
    const { brain, faux } = await brainWith(servers, fauxProvider(), 50);
    faux.setResponses([runFleet, fauxAssistantMessage('First.'), runFleet, fauxAssistantMessage('Second.')]);

    await brain.send({ ...thread, requestId: 'r4', text: 'Fleet?' }, 10_000);
    await vi.waitFor(() => expect(servers.closes()).toBe(1));
    await brain.send({ ...thread, requestId: 'r5', text: 'Again?' }, 10_000);

    expect(servers.opens()).toBe(2);
    expect(servers.calls).toHaveLength(2);
  });
});
