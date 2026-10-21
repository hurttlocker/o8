#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { buildPacketInfoSurface } from './.build/src/commands/packet/info-surface.js';
import { presentSurface } from './renderer.mjs';

const executeFile = promisify(execFile);
const HELP = `Read-only Tern experiment (not installed as an o8 subcommand).
node cli/experiments/tern/demo.mjs [--packet <id> | --fixture] [--text | --json]
With no packet ID, uses the packet bound to the current worktree.
Live mode runs only: o8 packet info [id] --json
--fixture is synthetic data, not live session or beta evidence.
`;

function parseArgs(args) {
  const parsed = { packet: null, fixture: false, text: false, json: false, help: false };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (seen.has(arg)) throw Error(`Duplicate argument: ${arg}`);
    seen.add(arg);
    if (arg === '--packet') {
      const value = args[++i];
      if (!value || value.startsWith('-') || value.includes('\0')) throw Error('--packet requires an ID argument');
      parsed.packet = value;
    } else if (['--fixture', '--text', '--json', '--help'].includes(arg)) {
      parsed[arg.slice(2)] = true;
    } else throw Error(`Unknown argument: ${arg}`);
  }
  if (parsed.fixture && parsed.packet !== null) throw Error('--fixture cannot be combined with --packet');
  if (parsed.json && parsed.text) throw Error('--json cannot be combined with --text');
  return parsed;
}

/** Validate the existing CLI envelope; absent evidence is never synthesized. */
export function parsePacketPayload(payload) {
  if (payload?.schema !== 'o8/cli/packet.info/v1') throw Error('Unexpected packet-info schema');
  const packet = payload.packet;
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)) throw Error('Missing packet object');
  for (const key of ['laneId', 'status', 'runtime', 'branch', 'baseBranch', 'repoPath', 'label']) {
    if (typeof packet[key] !== 'string') throw Error(`Invalid packet ${key}`);
  }
  for (const key of ['id', 'actualRuntime', 'worktreePath']) {
    if (packet[key] !== null && typeof packet[key] !== 'string') throw Error(`Invalid packet ${key}`);
  }
  if (!Array.isArray(packet.events)) throw Error('Missing packet events');
  for (const event of packet.events) {
    if (!event || ['id', 'timestamp', 'actor', 'verb'].some(key => typeof event[key] !== 'string')) {
      throw Error('Invalid packet event');
    }
  }
  return { ...packet, packetId: packet.id };
}

/** No server import or mutating command: reuse the already-governed CLI read. */
export async function runLab(args, options = {}) {
  const parsed = parseArgs(args);
  const output = options.output ?? process.stdout;
  if (parsed.help) { output.write(HELP); return; }
  let payload;
  if (parsed.fixture) {
    payload = JSON.parse(await readFile(new URL('./packet.fixture.json', import.meta.url), 'utf8'));
  } else {
    const argv = ['packet', 'info', ...(parsed.packet === null ? [] : [parsed.packet]), '--json'];
    const result = await (options.execute ?? executeFile)('o8', argv, {
      encoding: 'utf8', shell: false, timeout: 15_000, maxBuffer: 2 * 1024 * 1024,
    });
    if (result.stderr) (options.error ?? process.stderr).write(result.stderr);
    payload = JSON.parse(result.stdout);
  }
  const input = parsePacketPayload(payload);
  if (parsed.json) { output.write(`${JSON.stringify(payload, null, 2)}\n`); return; }
  return presentSurface(buildPacketInfoSurface(input), {
    ...options, output,
    env: parsed.text ? { ...(options.env ?? process.env), TERN_TSP: '0' } : options.env,
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runLab(process.argv.slice(2)).catch(error => {
    process.stderr.write(`tern lab: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = Number.isInteger(error?.code) && error.code > 0 && error.code < 256 ? error.code : 1;
  });
}
