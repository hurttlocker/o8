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
import { runCi } from './commands/ci.js';
import {
  runBoot,
  runCapabilities,
  runContract,
  runEvaluateDiff,
  runFeature,
  runGround,
  runHarness,
  runSprint,
  runVerify,
} from './commands/harness.js';
import { runInbox } from './commands/inbox.js';
import { runLaneTouches } from './commands/lane.js';
import { runMission } from './commands/mission.js';
import { runMcp } from './commands/mcp.js';
import { runProject, runRepo } from './commands/resources.js';
import { runProblem } from './commands/problem.js';
import { runStatus } from './commands/status.js';
import { runSession } from './commands/session.js';
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
import { runPacketWorkspace } from './commands/packet/workspace.js';
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
  version: boolean;
  secondaryBeforeRest: boolean;
}

const SINGLE_LEVEL_BOOLEAN_FLAGS = new Set([
  '--blocked',
  '--failed',
  '--failing',
  '--passed',
  '--passing',
  '--skipped',
  '--terse',
]);

/**
 * The shared parser reserves the first two bare tokens for command groups. For
 * a one-level command whose first argument is a valued flag, that flag's value
 * lands in `secondary`; put it back after the flag before command-level parsing.
 */
function singleLevelArgs(
  secondary: string | undefined,
  rest: string[],
  secondaryBeforeRest: boolean,
): string[] {
  if (!secondary) return rest;
  const first = rest[0];
  if (first?.startsWith('--') && !first.includes('=') && !SINGLE_LEVEL_BOOLEAN_FLAGS.has(first)) {
    // A valued flag before the positional argument puts its value in
    // `secondary` (`o8 ask --repo /path "question"`). When the positional
    // argument came first, the flag's real value is already next in `rest`
    // (`o8 ask "question" --repo /path`) and must stay there.
    return secondaryBeforeRest
      ? [secondary, ...rest]
      : [first, secondary, ...rest.slice(1)];
  }
  return [secondary, ...rest];
}

function parseArgs(argv: string[]): ParsedArgs {
  const command: string[] = [];
  const rest: string[] = [];
  let human = false;
  let jsonExplicit = false;
  let verbose = false;
  let help = false;
  let version = false;
  let secondaryIndex: number | null = null;
  let firstRestIndex: number | null = null;
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
    else if (tok === '--version' && command.length === 0) version = true;
    else if (tok.startsWith('-')) {
      if (firstRestIndex === null) firstRestIndex = i;
      rest.push(tok);
    } else if (command.length < 2 && !tok.startsWith('-')) {
      command.push(tok);
      if (command.length === 2) secondaryIndex = i;
    } else {
      if (firstRestIndex === null) firstRestIndex = i;
      rest.push(tok);
    }
    i++;
  }
  return {
    command,
    rest,
    mode: { human, verbose },
    jsonExplicit,
    help,
    version,
    secondaryBeforeRest: secondaryIndex !== null
      && (firstRestIndex === null || secondaryIndex < firstRestIndex),
  };
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
  feature list|next|add|verify  durable repo-scoped feature ledger
  ground "<task>"      persist a real-path impact map before execution
  boot [--task "..."]  session boot envelope: git, instructions, ledger, contract, grounding
  contract ...         propose and accept generator/evaluator contracts
  sprint ...           start or tick a one-feature-at-a-time sprint
  verify <feature-id>  record computational evidence and optionally tick a sprint
  harness ...          model-keyed lift, lifecycle, and HarnessBundle operations
  capabilities         discover harness artifacts and recommended call order
  evaluate-diff        independent skeptic review of a supplied or git diff
  ci [--config path]   run the versioned o8/ci/v1 local check contract
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
  worker spawn         create + dispatch one governed worker from any Git repo (--title --body [--repo path] [--runtime id] [--caller label] [--read-only])
  mission create       create a mission from an inline task (--title --body [--dispatch] [--caller label] [--read-only] [--existingBranchPolicy auto|reset|continue|error] [--compare m1,m2] [--quality-search-contract file])
  mission dispatch     dispatch packets to workers (async; --wait blocks for launch; --watch blocks until review/terminal — the spawner's notification) [--mission <id>]
  mission status       mission + packet state [--mission <id>] [--cost]
  mission stop         interrupt and hold every packet in a mission [--mission <id>]
  mission wait         block until a packet hits a review/terminal state [--timeout <milliseconds|5m|90s> --poll]
  mission tail         stream packet status transitions until terminal [--timeout <milliseconds|5m|90s> --poll]
  mcp install          install/print the o8 MCP config (--claude-code | --cursor | --opencode | --print)
  repo list            list repositories registered in the running o8 app
  repo add <path>      register an existing local Git repository
  repo remove <target> unregister by id, name, or path; the local folder is preserved
  project list         list projects, active state, and registered repo membership
  project create <name> [--repo <target>...]  create a project from registered repos
  project use <target> switch the active project by id or name
  project add-repo <project> <repo>     attach a registered repo to a project
  project remove-repo <project> <repo>  detach it while preserving registration and disk
  project delete <target>               remove a project and exclusive repo registrations; disk is preserved
  problem list         recurring problems detected across independent work (--all includes suppressed)
  problem show <id>    full evidence, remedy, and closure state for one problem dossier
  inbox list           pending governance approvals (--all includes resolved)
  inbox approve <id>   approve a card → runs the deferred action (e.g. a held merge)
  inbox reject <id>    reject a pending approval
  session show <key>   provider-native transform capabilities, lineage, and checkpoints
  session import <key> add a discovered provider session without claiming packet ownership
  session checkpoint <key> save a durable provider position for later forks
  session fork <key>   create a new provider session from a checkpoint
  session rewind <key> create a new continuation while preserving the original
  session resume <key> --message <text>  continue a durable provider session
  session dismiss-pending <key> --confirm-no-continuation  clear an unresolved attempt after provider inspection
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
  // The o8 CLI runs INSIDE an agent's packet worktree by design, and spawns
  // bare `git` / `gh`. Windows resolves a bare command name against the current
  // directory before PATH, so without this a repo shipping its own `git.cmd`
  // would be executed here — with whatever the CLI was invoked with. The server
  // processes set the same guard; this is the surface that actually runs in
  // untrusted trees.
  if (process.platform === 'win32') process.env.NoDefaultCurrentDirectoryInExePath = '1';
  const [primary, secondary] = args.command;
  if (args.version && !primary) return runVersion(args.mode);
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
      return runAsk(args.mode, singleLevelArgs(secondary, args.rest, args.secondaryBeforeRest));
    case 'feature':
      return runFeature(args.mode, secondary, args.rest);
    case 'ground':
      return runGround(args.mode, singleLevelArgs(secondary, args.rest, args.secondaryBeforeRest));
    case 'boot':
      return runBoot(args.mode, singleLevelArgs(secondary, args.rest, args.secondaryBeforeRest));
    case 'contract':
      return runContract(args.mode, secondary, args.rest);
    case 'sprint':
      return runSprint(args.mode, secondary, args.rest);
    case 'verify':
      return runVerify(args.mode, singleLevelArgs(secondary, args.rest, args.secondaryBeforeRest));
    case 'harness':
      return runHarness(args.mode, secondary, args.rest);
    case 'capabilities':
      return runCapabilities(args.mode, singleLevelArgs(secondary, args.rest, args.secondaryBeforeRest));
    case 'evaluate-diff':
      return runEvaluateDiff(args.mode, singleLevelArgs(secondary, args.rest, args.secondaryBeforeRest));
    case 'ci':
      return runCi(args.mode, singleLevelArgs(secondary, args.rest, args.secondaryBeforeRest));
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
    case 'worker': {
      if (secondary === 'spawn') return runMission(args.mode, 'create', [...args.rest, '--dispatch']);
      throw unknownSubcommandError('worker', secondary);
    }
    case 'mcp':
      return runMcp(args.mode, secondary, args.rest);
    case 'repo':
      return runRepo(args.mode, secondary, args.rest);
    case 'project':
      return runProject(args.mode, secondary, args.rest);
    case 'problem':
      return runProblem(args.mode, secondary, args.rest);
    case 'inbox':
      return runInbox(args.mode, secondary, args.rest);
    case 'session':
      return runSession(args.mode, secondary, args.rest);
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
      if (secondary === 'park' || secondary === 'restore') {
        return runPacketWorkspace(args.mode, secondary, args.rest);
      }
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
