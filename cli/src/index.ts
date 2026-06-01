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
import { runCortexObserve } from './commands/cortex.js';
import { runLaneTouches } from './commands/lane.js';
import { runStatus } from './commands/status.js';
import { runRun } from './commands/run.js';
import { runVersion } from './commands/version.js';
import { runPacketInfo } from './commands/packet/info.js';
import { runPacketHeartbeat } from './commands/packet/heartbeat.js';
import { runPacketLog } from './commands/packet/log.js';
import { runPacketReport } from './commands/packet/report.js';
import { runPacketCapture } from './commands/packet/capture.js';
import { runPacketMirrorProof } from './commands/packet/mirror-proof.js';
import { runPacketReview } from './commands/packet/review.js';
import { runPacketScope } from './commands/packet/scope.js';
import { runPacketRuntimeDrift } from './commands/packet/runtime-drift.js';
import { runPacketDiff } from './commands/packet/diff.js';
import { runPacketCommit } from './commands/packet/commit.js';
import { runSpec } from './commands/spec.js';
import {
  runTaskArchive,
  runTaskBlock,
  runTaskBrief,
  runTaskClaim,
  runTaskCreate,
  runTaskDispatch,
  runTaskList,
  runTaskPrune,
  runTaskReport,
} from './commands/task.js';
import { printError, type OutputMode } from './output.js';
import { CliError, EXIT } from './api.js';

function unknownSubcommandError(group: string, sub: string | undefined): CliError {
  return new CliError(
    `unknown_${group}_subcommand`,
    `Unknown ${group} subcommand: ${sub ?? '(none)'}`,
    EXIT.INVALID_ARGS,
    `Run \`o8 ${group} --help\` to list available subcommands.`,
  );
}

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
    if (tok === '--') {
      // End-of-options: everything after `--` is positional (used by `o8 run`
      // to pass a command containing its own flags). Stop interpreting flags.
      rest.push(...argv.slice(i + 1));
      break;
    }
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
  run [--detach] <cmd> run a process in an o8-owned terminal the operator can watch
  run --list           list managed runs (running + recent, with exit codes)
  cortex observe       propose a worker observation for the orchestrator
  lane touches         active lanes touching a path or packet diff
  task list            current task pool grouped by ready/running/review/etc.
  task create          add a project-backed task to the ready pool
  task brief <id>      project-backed task brief for a packet or lane
  task claim <id>      bind/reserve a task to a lane
  task dispatch <id>   launch the claimed task through Codex-only routing
  task block <id>      mark a task blocked with --reason
  task report <id>     append a structured task progress event
  task archive <id>    prune/archive stale task-pool rows
  task prune <id>      permanently remove done/archived task-pool rows
  packet info          info about the packet bound to the current worktree
  packet scope [id]    one-call worker context (auto-resolves from cwd)
  packet diff [id]     the packet's code diff vs base (committed + uncommitted)
  packet commit -m ".." stage + commit the worktree with an explicit pathspec
  packet heartbeat     update the current packet lane heartbeat
  packet review        approve + merge a reviewed packet
  packet report        append an agent_report event for this packet
  packet capture       screenshot the agent's app as visual proof (--url --label --before/--after --clip/--full-page --wait-for --hover/--click)
  packet mirror-proof  mirror the packet's before/after proof onto a GitHub PR (--pr <n> [--repo owner/repo])
  packet log [id]      read or follow packet lane events (--follow, --since)
  packet runtime-drift detect and warn when a lane's bound runtime drifted

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
  // `run` owns all flag parsing for its wrapped command (extractRunCommand reads
  // raw argv), so a `--help`/`-h` meant for the wrapped tool must NOT trigger o8's
  // global help here — otherwise `o8 run node --help` prints o8 USAGE + exit 0.
  if (args.help && primary !== 'run') {
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
      return runDoctor(args.mode, args.rest);
    case 'status':
      return runStatus(args.mode);
    case 'run':
      return runRun(args.mode, args.rest);
    case 'cortex': {
      if (secondary === 'observe') return runCortexObserve(args.mode, args.rest);
      throw unknownSubcommandError('cortex', secondary);
    }
    case 'lane': {
      if (secondary === 'touches') return runLaneTouches(args.mode, args.rest);
      throw unknownSubcommandError('lane', secondary);
    }
    case 'task': {
      if (secondary === 'list') return runTaskList(args.mode, args.rest);
      if (secondary === 'create') return runTaskCreate(args.mode, args.rest);
      if (secondary === 'brief') return runTaskBrief(args.mode, args.rest);
      if (secondary === 'claim') return runTaskClaim(args.mode, args.rest);
      if (secondary === 'dispatch') return runTaskDispatch(args.mode, args.rest);
      if (secondary === 'block') return runTaskBlock(args.mode, args.rest);
      if (secondary === 'report') return runTaskReport(args.mode, args.rest);
      if (secondary === 'archive') return runTaskArchive(args.mode, args.rest);
      if (secondary === 'prune') return runTaskPrune(args.mode, args.rest);
      throw unknownSubcommandError('task', secondary);
    }
    case 'packet': {
      if (secondary === 'info') return runPacketInfo(args.mode);
      if (secondary === 'scope') return runPacketScope(args.mode, args.rest);
      if (secondary === 'diff') return runPacketDiff(args.mode, args.rest);
      if (secondary === 'commit') return runPacketCommit(args.mode, args.rest);
      if (secondary === 'heartbeat') return runPacketHeartbeat(args.mode, args.rest);
      if (secondary === 'review') return runPacketReview(args.mode, args.rest);
      if (secondary === 'report') return runPacketReport(args.mode, args.rest);
      if (secondary === 'capture') return runPacketCapture(args.mode, args.rest);
      if (secondary === 'mirror-proof') return runPacketMirrorProof(args.mode, args.rest);
      if (secondary === 'log') return runPacketLog(args.mode, args.rest);
      if (secondary === 'runtime-drift') return runPacketRuntimeDrift(args.mode);
      throw unknownSubcommandError('packet', secondary);
    }
    case 'spec':
      return runSpec(args.mode, secondary, args.rest);
    default:
      throw new CliError(
        'unknown_command',
        `Unknown command: ${primary}`,
        EXIT.INVALID_ARGS,
        'Run `o8 --help` for the full command surface.',
      );
  }
}

const parsed = parseArgs(process.argv.slice(2));
try {
  const code = await dispatch(parsed);
  process.exit(code);
} catch (err) {
  process.exit(printError(err, parsed.mode));
}
