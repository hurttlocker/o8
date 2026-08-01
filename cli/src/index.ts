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

import { runAsk } from './commands/ask.js';
import { runApp } from './commands/app.js';
import { runBrowser } from './commands/browser.js';
import { runConnect } from './commands/connect.js';
import { runDoctor } from './commands/doctor.js';
import { runCortexObserve } from './commands/cortex.js';
import { runInbox } from './commands/inbox.js';
import { runLaneTouches } from './commands/lane.js';
import { runMission } from './commands/mission.js';
import { runMcp } from './commands/mcp.js';
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
import { runPacketClose } from './commands/packet/close.js';
import { runPacketStop } from './commands/packet/stop.js';
import {
  PACKET_COMMAND_LINES,
  packetGroupUsage,
  packetSubcommandHint,
} from './commands/packet/help.js';
import {
  runPacketMergePreview,
  runPacketRerun,
  runPacketApproveMerge,
  runPacketReset,
  runPacketRetry,
  runPacketSteer,
} from './commands/packet/recover.js';
import { runSpec } from './commands/spec.js';
import { runTeam } from './commands/team.js';
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
import { runUpdate } from './commands/update.js';
import { printError, type OutputMode } from './output.js';
import { CliError, EXIT } from './api.js';

function unknownSubcommandError(group: string, sub: string | undefined): CliError {
  return new CliError(
    `unknown_${group}_subcommand`,
    `Unknown ${group} subcommand: ${sub ?? '(none)'}`,
    EXIT.INVALID_ARGS,
    group === 'packet'
      ? packetSubcommandHint()
      : `Run \`o8 ${group} --help\` to list available subcommands.`,
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
  doctor               verify port + token resolution, ping server; --repair reinstalls the o8 CLI symlink
  status               snapshot: running packets, lanes, merges, approvals
  connect [--status]   register this signed-in machine, or list connected machines
  disconnect           remove this machine from the operator's connected devices
  run [--detach] <cmd> run a process in an o8-owned terminal the operator can watch
  run --list           list managed runs (running + recent, with exit codes)
  run stop <runId>     stop a managed run from o8 run --list
  ask [--terse] "<question>"  ask the Engineering Brain about this repo (answer + cited sources)
  app restart [--if-update-pending]  request an app restart; optionally no-op unless an update is pending
  update apply [--force]  apply an available update when idle; --force overrides live-work refusal
  browser open [url]   open a page — localhost rides o8's embedded browser, external URLs auto-route to headless Chrome (engine)
  browser read         page text + interactive elements (selectors)
  browser click <sel>  click an element (ghost cursor paints in the o8 UI)
  browser type <sel> <text…>  type into an input (--submit presses Enter)
  browser wait <sel>   poll until a selector resolves (--text, --timeout)
  browser close        end this scope's engine (headless Chrome) session
  cortex observe       propose a worker observation for the orchestrator
  lane touches         active lanes touching a path or packet diff
  mission create       create a mission from an inline task (--title --body [--compare m1,m2])
  mission dispatch     dispatch packets to workers (async; --wait blocks for launch; --watch blocks until review/terminal — the spawner's notification) [--mission <id>]
  mission status       mission + packet state [--mission <id>] [--cost]
  mission stop         interrupt and hold every packet in a mission [--mission <id>]
  mission wait         block until a packet hits a review/terminal state [--timeout <milliseconds|5m|90s> --poll]
  mission tail         stream packet status transitions until terminal [--timeout <milliseconds|5m|90s> --poll]
  mcp install          install/print the o8 MCP config (--claude-code | --cursor | --print)
  inbox list           pending governance approvals (--all includes resolved)
  inbox approve <id>   approve a card → runs the deferred action (e.g. a held merge)
  inbox reject <id>    reject a pending approval
  task list            current task pool grouped by ready/running/review/etc.
  task create          add a project-backed task to the ready pool
  task brief <id>      project-backed task brief for a packet or lane
  task claim <id>      bind/reserve a task to a lane
  task dispatch <id>   launch the claimed task through Codex-only routing
  task block <id>      mark a task blocked with --reason
  task report <id>     append a structured task progress event
  task archive <id>    prune/archive stale task-pool rows
  task prune <id>      permanently remove done/archived task-pool rows
${PACKET_COMMAND_LINES}

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
  6 server timeout (ambiguous: the operation may have landed)

error JSON:
  error.ambiguous is true when retry safety cannot be inferred from the result
`;

/**
 * Group-scoped help (#1576): `o8 packet --help` used to print the GLOBAL usage
 * while unknownSubcommandError's hint pointed right back at it — a circle.
 * Extract the group's own lines from USAGE; null when the group has none
 * (caller falls back to the full USAGE).
 */
function groupUsage(group: string): string | null {
  if (group === 'packet') return packetGroupUsage();
  const lines = USAGE.split('\n').filter((line) => new RegExp(`^  ${group}( |$)`).test(line));
  if (lines.length === 0) return null;
  return `usage: o8 ${group} <subcommand> [flags]\n\n${lines.join('\n')}\n\nRun \`o8 --help\` for the full command surface.\n`;
}

async function dispatch(args: ParsedArgs): Promise<number> {
  const [primary, secondary] = args.command;
  // `run` owns all flag parsing for its wrapped command (extractRunCommand reads
  // raw argv), so a `--help`/`-h` meant for the wrapped tool must NOT trigger o8's
  // global help here — otherwise `o8 run node --help` prints o8 USAGE + exit 0.
  if (args.help && primary !== 'run') {
    process.stdout.write((primary && groupUsage(primary)) || USAGE);
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
    case 'connect':
      return runConnect(args.mode, 'connect', secondary ? [secondary, ...args.rest] : args.rest);
    case 'disconnect':
      return runConnect(args.mode, 'disconnect', secondary ? [secondary, ...args.rest] : args.rest);
    case 'run':
      return runRun(args.mode, args.rest);
    case 'ask':
      // The question lands in `secondary` (first positional) when quoted, or
      // spreads across secondary + rest when unquoted — hand both to the parser.
      return runAsk(args.mode, secondary ? [secondary, ...args.rest] : args.rest);
    case 'app':
      return runApp(args.mode, secondary, args.rest);
    case 'update':
      return runUpdate(args.mode, secondary, args.rest);
    case 'browser':
      return runBrowser(args.mode, secondary, args.rest);
    case 'cortex': {
      if (secondary === 'observe') return runCortexObserve(args.mode, args.rest);
      throw unknownSubcommandError('cortex', secondary);
    }
    case 'lane': {
      if (secondary === 'touches') return runLaneTouches(args.mode, args.rest);
      throw unknownSubcommandError('lane', secondary);
    }
    case 'mission':
      return runMission(args.mode, secondary, args.rest);
    case 'mcp':
      return runMcp(args.mode, secondary, args.rest);
    case 'inbox':
      return runInbox(args.mode, secondary, args.rest);
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
      if (secondary === 'info') return runPacketInfo(args.mode, args.rest);
      if (secondary === 'scope') return runPacketScope(args.mode, args.rest);
      if (secondary === 'diff') return runPacketDiff(args.mode, args.rest);
      if (secondary === 'commit') return runPacketCommit(args.mode, args.rest);
      if (secondary === 'heartbeat') return runPacketHeartbeat(args.mode, args.rest);
      if (secondary === 'review') return runPacketReview(args.mode, args.rest);
      if (secondary === 'close') return runPacketClose(args.mode, args.rest);
      if (secondary === 'reset') return runPacketReset(args.mode, args.rest);
      if (secondary === 'stop' || secondary === 'cancel') return runPacketStop(args.mode, args.rest);
      if (secondary === 'retry') return runPacketRetry(args.mode, args.rest);
      if (secondary === 'rerun') return runPacketRerun(args.mode, args.rest);
      if (secondary === 'steer') return runPacketSteer(args.mode, args.rest);
      if (secondary === 'approve-merge') return runPacketApproveMerge(args.mode, args.rest);
      if (secondary === 'merge-preview') return runPacketMergePreview(args.mode, args.rest);
      if (secondary === 'report') return runPacketReport(args.mode, args.rest);
      if (secondary === 'capture') return runPacketCapture(args.mode, args.rest);
      if (secondary === 'mirror-proof') return runPacketMirrorProof(args.mode, args.rest);
      if (secondary === 'log') return runPacketLog(args.mode, args.rest);
      if (secondary === 'runtime-drift') return runPacketRuntimeDrift(args.mode, args.rest);
      throw unknownSubcommandError('packet', secondary);
    }
    case 'spec':
      return runSpec(args.mode, secondary, args.rest);
    case 'team':
      return runTeam(args.mode, secondary, args.rest);
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
