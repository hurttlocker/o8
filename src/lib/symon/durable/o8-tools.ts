/**
 * Read-only o8 commands for the durable Symon brain (#3474).
 *
 * The brain gets the same three catalog tools the Pi orchestrator uses
 * (`o8_commands`, `o8_command_help`, `o8_run`), backed by the `propose` tool
 * profile: the operator server, which dispatches and merges, is not opened,
 * and cortex runs read-only. The servers open on first use and close after an
 * idle period; the next call reopens them.
 *
 * A call a restart interrupts is reported to the model as interrupted and is
 * never run again.
 */

import { homedir } from 'node:os';
import { Type } from '@earendil-works/pi-ai';
import { defineExtension, defineTool, section, type Extension } from '@earendil-works/pi-durable';
import type { PiHostTool } from '@/lib/pi/sdk/session';
import { createO8CommandTools, listO8Commands } from '@/lib/pi/orchestrator/o8-commands';
import { openO8Servers, type O8ServerSet } from '@/lib/pi/orchestrator/o8-servers';

export type OpenSymonO8Servers = () => Promise<O8ServerSet>;

/** Production servers: the read-only projection, outside any repository. */
export const openReadOnlyO8Servers: OpenSymonO8Servers = () => openO8Servers(homedir(), { profile: 'propose' });

export const SYMON_O8_TOOLS_IDLE_MS = 15 * 60_000;

const PROMPT = [
  'You can look things up in o8 with o8_commands, o8_command_help and o8_run: what is running, waiting for review or approval,',
  'and the state of projects, issues, pull requests and CI. These commands only read. You cannot start, approve, merge or change',
  'anything; say so and suggest opening o8 when asked to. Answer from what a command returned, and never claim a result you did not get.',
].join(' ');

const UNAVAILABLE = 'o8 commands are not available right now.';

export interface SymonO8Tools {
  extension: Extension;
  close(): Promise<void>;
}

export function createSymonO8Tools(open: OpenSymonO8Servers, idleMs = SYMON_O8_TOOLS_IDLE_MS): SymonO8Tools {
  let ready: Promise<{ set: O8ServerSet; tools: PiHostTool[] }> | null = null;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let active = 0;

  const close = async () => {
    if (idle) clearTimeout(idle);
    idle = undefined;
    const current = ready;
    ready = null;
    if (current) await current.then(({ set }) => set.close(), () => {});
  };

  const settle = () => {
    if (idle) clearTimeout(idle);
    idle = active === 0 ? setTimeout(() => { void close(); }, idleMs) : undefined;
    idle?.unref?.();
  };

  const acquire = (signal: AbortSignal) => {
    ready ??= (async () => {
      const set = await open();
      try {
        return { set, tools: createO8CommandTools(await listO8Commands(set.servers, signal)) };
      } catch (error) {
        await set.close();
        throw error;
      }
    })();
    const attempt = ready;
    attempt.catch(() => { if (ready === attempt) ready = null; });
    return attempt;
  };

  const run = (index: number) => async (args: Record<string, unknown>, _api: unknown, context: { abortSignal: AbortSignal | undefined }) => {
    const signal = context.abortSignal ?? new AbortController().signal;
    active += 1;
    if (idle) clearTimeout(idle);
    try {
      let tools: PiHostTool[];
      try {
        tools = (await acquire(signal)).tools;
      } catch {
        return { content: [{ type: 'text' as const, text: UNAVAILABLE }], isError: true };
      }
      const result = await tools[index].execute(args, signal);
      return { content: result.content };
    } finally {
      active -= 1;
      settle();
    }
  };

  const extension = defineExtension({
    name: 'symon-o8',
    sections: [section('o8-commands', () => PROMPT, { tag: false })],
    tools: [
      defineTool({
        name: 'o8_commands',
        description: 'List the read-only o8 commands with a one-line summary each. Pass query to filter by name or description.',
        parameters: Type.Object({ query: Type.Optional(Type.String()) }),
        execute: run(0),
      }),
      defineTool({
        name: 'o8_command_help',
        description: 'Show one o8 command\'s full description and argument schema. Read it before running a command for the first time.',
        parameters: Type.Object({ name: Type.String() }),
        execute: run(1),
      }),
      defineTool({
        name: 'o8_run',
        description: 'Run one read-only o8 command. Pass its arguments as a JSON object string, as its schema in o8_command_help defines them.',
        parameters: Type.Object({ name: Type.String(), arguments: Type.Optional(Type.String()) }),
        execute: run(2),
      }),
    ],
  });

  return { extension, close };
}
