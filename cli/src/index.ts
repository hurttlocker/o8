/**
 * o8 CLI — agent-first wrapper over the local HTTP API.
 *
 * Design principles (epic #926):
 *   - Agent-first I/O: JSON to stdout by default, --human for pretty fallback.
 *   - Exit codes that mean things: 0 ok, 1 invalid args, 2 connection refused,
 *     3 unauthorized, 4 not found, 5 conflict. Agents branch on these without
 *     parsing strings.
 *   - Stable, schema-versioned output. Every payload carries `schema: o8/cli/<cmd>/v1`.
 *   - No telemetry, no auto-update, no prompts. Failures loud (stderr),
 *     successes silent unless --verbose.
 *   - DRY with MCP: every command is fetch + JSON shape, no business logic.
 *   - Auto-discovery: env first (O8_API_PORT / O8_API_TOKEN), then ~/.o8/,
 *     then legacy ~/.cortex-ide/, then fallback 3001.
 *
 * Handrolled dispatcher; deliberately no commander/yargs/oclif dependency.
 */

import { runDoctor } from './commands/doctor.js';
import { runStatus } from './commands/status.js';
import { runVersion } from './commands/version.js';
import { runPacketInfo } from './commands/packet/info.js';
import { runPacketLog } from './commands/packet/log.js';
import { printError, type OutputMode } from './output.js';

interface ParsedArgs {
  command: string[];
  rest: string[];
  mode: OutputMode;
  jsonExplicit: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const command: string[] = [];
  const rest: string[] = [];
  let human = false;
  let jsonExplicit = false;
  let verbose = false;
  let help = false;
  let i = 0;
  while (i < argv.length) {
    const tok = argv[i];
    if (tok === '--human') human = true;
    else if (tok === '--json') jsonExplicit = true;
    else if (tok === '--verbose' || tok === '-v') verbose = true;
    else if (tok === '--help' || tok === '-h') help = true;
    else if (tok.startsWith('-')) rest.push(tok);
    else if (command.length < 2 && !tok.startsWith('-')) command.push(tok);
    else rest.push(tok);
    i++;
  }
  return { command, rest, mode: { human, verbose }, jsonExplicit, help };
}

const USAGE = `o8 — agent-first CLI for the local o8 control plane.

usage: o8 <command> [subcommand] [flags]

commands:
  version              CLI version + connected server version
  doctor               verify port + token resolution, ping server
  status               snapshot: running packets, lanes, merges, approvals
  packet info          info about the packet bound to the current worktree
  packet log <event>   append a structured event to the lane history

flags:
  --json (default)     JSON output for agents
  --human              pretty ANSI output for humans
  -v, --verbose        extra detail
  -h, --help           show this help

env:
  O8_API_PORT          override port (set by dispatch for worker agents)
  O8_API_TOKEN         override bearer token (set by dispatch)
  CORTEX_IDE_DATA_DIR  override data dir (default ~/.o8, legacy ~/.cortex-ide)

exit codes:
  0 ok   1 invalid args   2 connection refused
  3 unauthorized   4 not found   5 conflict
`;

async function dispatch(args: ParsedArgs): Promise<number> {
  const [primary, secondary] = args.command;
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!primary) {
    process.stdout.write(USAGE);
    return 1;
  }
  switch (primary) {
    case 'version':
      return runVersion(args.mode);
    case 'doctor':
      return runDoctor(args.mode);
    case 'status':
      return runStatus(args.mode);
    case 'packet': {
      if (secondary === 'info') return runPacketInfo(args.mode);
      if (secondary === 'log') return runPacketLog(args.mode, args.rest);
      process.stderr.write(`unknown packet subcommand: ${secondary ?? '(none)'}\n`);
      return 1;
    }
    default:
      process.stderr.write(`unknown command: ${primary}\n${USAGE}`);
      return 1;
  }
}

const parsed = parseArgs(process.argv.slice(2));
try {
  const code = await dispatch(parsed);
  process.exit(code);
} catch (err) {
  process.exit(printError(err, parsed.mode));
}
