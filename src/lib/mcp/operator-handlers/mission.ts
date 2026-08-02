import {
  isAgentReportReason,
  normalizeAgentReportEvent,
  normalizeAgentReportMessage,
  normalizeAgentReportMetadata,
} from '@/lib/lane/agent-report';
import {
  createMission,
  createMissionInline,
  dispatchMission,
  getMissionStatus,
  rerunWithFeedback,
  resetPacket,
  submitPacketReview,
} from '@/lib/mcp/operator-mission-tools';
import { getPacketScope } from '@/lib/lanes/scope';
import {
  archiveTask,
  blockTask,
  claimTask,
  createTask,
  dispatchTask,
  pruneTask,
  reportTask,
} from '@/lib/tasks/actions';
import { getTaskPool, getTaskPoolTask } from '@/lib/tasks/pool';
import type { ExistingBranchPolicy } from '@/lib/orchestrator/operator-mission-service';
import { nextInlineIssueNumbers } from '@/lib/orchestrator/operator-mission-service/shared';
import {
  isRuntimeWorkerProvider,
  listDispatchableRuntimes,
  listDispatchableWorkerProviders,
} from '@/lib/orchestrator/runtime-capabilities';
import {
  apiFetch,
  type McpTool,
  type McpToolResult,
  errorText,
  jsonResult,
  optionalString,
  parseDirectivesApplied,
  parseDirectivesViolated,
  parseIssueList,
  parseMissionRuntime,
  parseReviewFindings,
  requiredString,
  textResult,
} from './shared';
import type { WorkerIntent, WorkerProvider } from '@/lib/orchestrator/types';
import { parseMissionCandidateMode, QUALITY_SEARCH_INPUT_SCHEMA } from './quality-search-input';
import { CONTRACT_COVERAGE_EVIDENCE_SCHEMA, parseContractCoverageEvidenceInput } from './review-coverage-input';
const WORKER_PROVIDER_OPTIONS: WorkerProvider[] = [...listDispatchableWorkerProviders(), 'minimax'];

export const MISSION_TOOLS: McpTool[] = [
  {
    name: 'create_mission',
    description:
      'USE THIS WHEN the user wants to delegate one or more coding tasks to autonomous agents — phrasings like "fix issues #X, #Y", "dispatch this bug", "have an agent work on...", "build me a feature for...". Don\'t code it yourself — o8 spawns CLI runtimes in isolated worktrees, runs governance checks, and ships a clean PR. By default packets run in parallel and dispatch immediately. Use `issues` for GitHub refs (any format: 495, "#495", URL), or `issues_inline` for ad-hoc tasks without GitHub issues. Examples: create_mission({issues: [495, 496], repoPath: "/path/to/repo"}) creates from GitHub issues. create_mission({issues_inline: [{title: "Add dark mode"}, {title: "Fix login button"}], repoPath: "/path/to/repo"}) creates from inline descriptions.',
    inputSchema: {
      type: 'object',
      properties: {
        issues: {
          type: 'array',
          items: { type: 'string' },
          description: 'GitHub issue references. Accepts any format: "495", "#495", or "https://github.com/org/repo/issues/495" (pass numbers as strings). Fetches full issue data via `gh` CLI.',
        },
        issues_inline: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Task summary / issue title.' },
              body: { type: 'string', description: 'Detailed description (optional).' },
            },
            required: ['title'],
          },
          description: 'Ad-hoc inline tasks — no GitHub issue required. Each becomes its own packet.',
        },
        repoPath: {
          type: 'string',
          description: 'Absolute local path to the repository.',
        },
        runtime: {
          type: 'string',
          enum: listDispatchableRuntimes(),
          description: 'Worker runtime for all mission packets. Codex remains the default; configured local CLI adapters are selected explicitly.',
        },
        workerIntent: {
          type: 'string',
          enum: ['light_worker', 'heavy_worker', 'reviewer', 'diagnostic', 'orchestrator'],
          description: 'Desired worker type. Production still selects Codex as the runtime.',
        },
        requestedProvider: {
          type: 'string',
          enum: WORKER_PROVIDER_OPTIONS,
          description: 'Future provider hint. Preserved in routing metadata; production still selects Codex.',
        },
        constraints: {
          type: 'string',
          description: 'Optional sprint-wide constraints that should be included in packet scope.',
        },
        sequential: {
          type: 'boolean',
          description: 'When true, packets run sequentially (P2 after P1, etc.). Default: false (all packets run in parallel).',
        },
        existingBranchPolicy: {
          type: 'string',
          enum: ['auto', 'reset', 'continue', 'error'],
          description: 'How to handle an existing issue/inline branch. Default auto resets stale or spec-changed attempts, and asks on ambiguous active attempts. Use reset to force fresh-from-main, continue to resume an active same-spec lane.',
        },
        dispatch: {
          type: 'boolean',
          description: 'When true (default), immediately dispatches all packets after creation. Set false to create without dispatching.',
        },
        useBrain: {
          type: 'boolean',
          description: 'Engineering Brain for the workers. true: every packet prompt teaches the worker `o8 ask` (instant cited repo answers — use for weaker models or knowledge-heavy tasks). false: suppress. Omit to inherit the operator "Workers use the Brain" setting (auto = on for non-frontier runtimes only).',
        },
        huddle: {
          type: 'boolean',
          description: 'Huddle mode — a bidirectional alignment turn. When true, each worker reads the repo then posts its plan + any pushback (`o8 packet report --event huddle`) and STOPS before editing; you review it (the packet flips to awaiting_orchestrator) and steer it (steer_packet) to align before it implements. Arm it ONLY on packets worth aligning on first — ambiguous scope, risky/cross-cutting, or novel work. Omit (default off) for clear, well-specced packets so they don\'t pay the extra round-trip.',
        },
        comparisonModels: {
          type: 'array',
          items: { type: 'string' },
          description: 'Best-of-N — race the task across N candidates (one per model string), each in its own isolated worktree. The operator then compares the N diffs side-by-side and merges the winner through the review gate, archiving the losers. Same model repeated (["codex","codex","codex"]) runs N attempts of one runtime; mix runtimes (["codex","gemini"]) to compare them. Max 4. Omit for a single packet. Use when a task is worth a bake-off — risky, ambiguous, or when you want the best of several attempts.',
        },
        qualitySearch: QUALITY_SEARCH_INPUT_SCHEMA,
        orchestratorThreadId: {
          type: 'string',
          description: 'Session-rule inheritance (#1329) — your active orchestrator thread id (e.g. "thoughts-…"). When set, every worker prompt carries the thread\'s active "Operator session rules (binding)" block and dispatch records a rules_applied lane event. Omit when dispatching outside a rule-bearing thread.',
        },
      },
      required: ['repoPath'],
    },
  },
  {
    name: 'dispatch_mission',
    description:
      'USE THIS RARELY — create_mission already dispatches by default. Only call this after reset_packet to relaunch a packet, or if the user explicitly says "redispatch". Example: dispatch_mission() dispatches current mission. dispatch_mission({missionId: "mission-abc123"}) dispatches a specific one.',
    inputSchema: {
      type: 'object',
      properties: {
        missionId: {
          type: 'string',
          description: 'Optional mission ID. If omitted, dispatches the current stored mission.',
        },
      },
    },
  },
  {
    name: 'get_mission_status',
    description:
      'USE THIS WHEN the user asks "how\'s the mission going", "what\'s the status of my dispatch", or right before each tick of an automated review loop to see which packets are awaiting_review / running / blocked. Returns waves, packet state, active agents, blockers, optional cost. Example: get_mission_status() returns current mission. get_mission_status({includeCost: true}) adds cost breakdown.',
    inputSchema: {
      type: 'object',
      properties: {
        missionId: {
          type: 'string',
          description: 'Optional mission ID. If omitted, reads the current stored mission.',
        },
        includeCost: {
          type: 'boolean',
          description: 'Include aggregated runtime cost for the mission.',
        },
      },
    },
  },
  {
    name: 'mission_tail',
    description:
      'Return a batch of lane events for one packet with a nextSince unix-ms cursor. Poll this instead of get_mission_status when the orchestrator needs progress events for a packet. Example: mission_tail({packetId: "pkt-abc", since: 1710000000000})',
    inputSchema: {
      type: 'object',
      properties: {
        packetId: {
          type: 'string',
          description: 'Packet id to tail.',
        },
        since: {
          type: 'number',
          description: 'Unix-ms cursor from the previous response. Omit for the first batch.',
        },
        timeoutMs: {
          type: 'number',
          description: 'Optional long-poll timeout in ms. Default 0; max 25000.',
        },
      },
      required: ['packetId'],
    },
  },
  {
    name: 'get_packet_scope',
    description:
      'Return one-call worker context for a packet or lane: project brief, main/current/related repos, active locks, branch, base, head SHA, worktree, file ceiling, allowed/blocked paths, repo-filtered directives, and active related packets with overlapping files. Provide packetId or laneId.',
    inputSchema: {
      // No top-level anyOf — OpenAI strict function-calling rejects oneOf /
      // anyOf / allOf siblings to `type: 'object'`. Handler validates that
      // either packetId or laneId is present and throws if neither is.
      type: 'object',
      properties: {
        packetId: {
          type: 'string',
          description: 'Packet id, for example pkt-abc. Either packetId or laneId is required.',
        },
        laneId: {
          type: 'string',
          description: 'Lane id, for example lane-xyz. Either packetId or laneId is required.',
        },
      },
    },
  },
  {
    name: 'o8_packet_diff',
    description:
      "Read a packet's actual code diff (committed + uncommitted) against where its lane diverged from base — what to review before approving, without raw shell. Byte-bounded (default 64KB; pass maxBytes to raise, cap 512KB). Provide packetId or laneId.",
    inputSchema: {
      type: 'object',
      properties: {
        packetId: { type: 'string', description: 'Packet id (e.g. pkt-abc). Either packetId or laneId is required.' },
        laneId: { type: 'string', description: 'Lane id (e.g. lane-xyz). Either packetId or laneId is required.' },
        maxBytes: { type: 'number', description: 'Max diff bytes to return (default 65536, cap 524288).' },
      },
    },
  },
  {
    name: 'o8_task_list',
    description:
      'Return the simple o8 task pool grouped as ready, running, review, blocked, and done. This is a projection of packets and lanes, not a separate task store. Use it before claiming or dispatching work.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'string',
          description: 'Optional project id or slug filter.',
        },
        repoPath: {
          type: 'string',
          description: 'Optional absolute repo path filter.',
        },
        includeDone: {
          type: 'boolean',
          description: 'Include released/completed/archived tasks. Default false.',
        },
        includeBrief: {
          type: 'boolean',
          description: 'Include full project-backed task briefs on each task. Default false; prefer o8_task_brief for one task.',
        },
      },
    },
  },
  {
    name: 'o8_task_create',
    description:
      'Create a project-backed task in the o8 task pool. This creates a queued packet in the existing packet/lane control plane; it does not spawn a worker until o8_task_dispatch is called.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Short task title.',
        },
        summary: {
          type: 'string',
          description: 'Optional task detail or brief.',
        },
        projectId: {
          type: 'string',
          description: 'Optional project id or slug. If omitted, o8 resolves the active project.',
        },
        repoPath: {
          type: 'string',
          description: 'Optional absolute repo path for the current repo.',
        },
        workerIntent: {
          type: 'string',
          enum: ['light_worker', 'heavy_worker', 'reviewer', 'diagnostic', 'orchestrator'],
          description: 'Desired worker type. Production still selects Codex as the runtime.',
        },
        requestedProvider: {
          type: 'string',
          enum: WORKER_PROVIDER_OPTIONS,
          description: 'Future provider hint. Preserved in routing metadata; production still selects Codex.',
        },
        requestedRuntime: {
          type: 'string',
          enum: listDispatchableRuntimes(),
          description: 'Worker runtime for this task. When omitted, the operator default applies.',
        },
        model: {
          type: 'string',
          description: 'Optional per-packet model hint. It is applied when its model house matches the selected runtime, including Claude models on claude-code packets.',
        },
        allowedFiles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional allowed file hints for the packet brief.',
        },
      },
      required: ['title'],
    },
  },
  {
    name: 'o8_task_brief',
    description:
      'Return one project-backed task brief for a packet or lane id. Use this when a worker needs the exact main repo, current repo, related repo, and output policy before editing.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'Packet id, lane id, or task id.',
        },
        projectId: {
          type: 'string',
          description: 'Optional project id or slug filter.',
        },
        repoPath: {
          type: 'string',
          description: 'Optional absolute repo path filter.',
        },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'o8_task_claim',
    description:
      'Claim a task from the o8 task pool by binding/reserving it to a lane without launching a runtime. Use before dispatch when an agent wants an explicit ownership point.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'Packet id, lane id, or task id.',
        },
        note: {
          type: 'string',
          description: 'Optional claim note.',
        },
        projectId: {
          type: 'string',
          description: 'Optional project id or slug filter.',
        },
        repoPath: {
          type: 'string',
          description: 'Optional absolute repo path filter.',
        },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'o8_task_dispatch',
    description:
      'Dispatch a task from the o8 task pool through Codex-only production routing. This launches the lane and injects the project-backed task brief.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'Packet id, lane id, or task id.',
        },
        message: {
          type: 'string',
          description: 'Optional dispatch note appended to the task brief.',
        },
        model: {
          type: 'string',
          description: 'Optional runtime model override.',
        },
        workerIntent: {
          type: 'string',
          enum: ['light_worker', 'heavy_worker', 'reviewer', 'diagnostic', 'orchestrator'],
          description: 'Desired worker type. Production still selects Codex as the runtime.',
        },
        requestedProvider: {
          type: 'string',
          enum: WORKER_PROVIDER_OPTIONS,
          description: 'Future provider hint. Preserved in routing metadata; production still selects Codex.',
        },
        requestedRuntime: {
          type: 'string',
          enum: listDispatchableRuntimes(),
          description: 'Worker runtime for this task. When omitted, the operator default applies.',
        },
        projectId: {
          type: 'string',
          description: 'Optional project id or slug filter.',
        },
        repoPath: {
          type: 'string',
          description: 'Optional absolute repo path filter.',
        },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'o8_task_block',
    description:
      'Mark a task blocked with a human-readable reason. This moves the lane to awaiting_orchestrator and updates the task pool blocked group.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'Packet id, lane id, or task id.',
        },
        reason: {
          type: 'string',
          description: 'Human-readable block reason.',
        },
        code: {
          type: 'string',
          enum: [
            'needs_clarification',
            'missing_context',
            'out_of_scope',
            'dependency_blocked',
            'context_full',
            'nondeterministic_test',
            'external_api_down',
            'unknown',
          ],
          description: 'Optional normalized blocker code.',
        },
        projectId: {
          type: 'string',
          description: 'Optional project id or slug filter.',
        },
        repoPath: {
          type: 'string',
          description: 'Optional absolute repo path filter.',
        },
      },
      required: ['taskId', 'reason'],
    },
  },
  {
    name: 'o8_task_report',
    description:
      'Append a structured progress report to a task lane. event:"blocked" or event:"question" also moves the task to awaiting_orchestrator.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'Packet id, lane id, or task id.',
        },
        event: {
          type: 'string',
          description: 'Report event, for example progress, blocked, question, or handoff.',
        },
        status: {
          type: 'string',
          description: 'Alias for event when callers think in status terms.',
        },
        reason: {
          type: 'string',
          enum: [
            'needs_clarification',
            'missing_context',
            'out_of_scope',
            'dependency_blocked',
            'context_full',
            'nondeterministic_test',
            'external_api_down',
            'unknown',
          ],
          description: 'Optional normalized report reason.',
        },
        message: {
          type: 'string',
          description: 'Optional human-readable detail.',
        },
        metadata: {
          type: 'object',
          description: 'Optional structured metadata to attach to the report.',
        },
        projectId: {
          type: 'string',
          description: 'Optional project id or slug filter.',
        },
        repoPath: {
          type: 'string',
          description: 'Optional absolute repo path filter.',
        },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'o8_task_archive',
    description:
      'Archive a stale task-pool row by archiving its lane and marking its packet archived. Use this to prune old session_lost or launch_error rows from active ready/running pools while preserving history.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'Packet id, lane id, or task id.',
        },
        reason: {
          type: 'string',
          description: 'Optional cleanup reason.',
        },
        projectId: {
          type: 'string',
          description: 'Optional project id or slug filter.',
        },
        repoPath: {
          type: 'string',
          description: 'Optional absolute repo path filter.',
        },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'o8_task_prune',
    description:
      'Permanently prune a done/archived task-pool row after the work is genuinely complete. Removes the terminal packet and lane from the visible pool, so use archive first for active or stale rows.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'Packet id, lane id, or task id.',
        },
        reason: {
          type: 'string',
          description: 'Optional cleanup reason.',
        },
        projectId: {
          type: 'string',
          description: 'Optional project id or slug filter.',
        },
        repoPath: {
          type: 'string',
          description: 'Optional absolute repo path filter.',
        },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'wait_for_mission_ready',
    description:
      'Long-poll until any packet in the mission transitions to a terminal/review state (awaiting_review, released, failed, archived) or the mission completes. Returns the same payload as get_mission_status plus a `wakeReason` field ("state-change" | "timeout" | "already-terminal"). Use after dispatching to get notified when Codex is done without manually polling. Specify `packetId` to wait for a specific packet only. Default timeout 600000ms (10 min); cap 1800000ms (30 min).',
    inputSchema: {
      type: 'object',
      properties: {
        missionId: {
          type: 'string',
          description: 'Optional mission ID. If omitted, watches the current stored mission.',
        },
        packetId: {
          type: 'string',
          description: 'Optional packet ID. When set, returns when this specific packet hits a terminal state.',
        },
        timeoutMs: {
          type: 'number',
          description: 'Max time to wait in ms. Default 600000 (10 min); capped at 1800000 (30 min).',
        },
        pollIntervalMs: {
          type: 'number',
          description: 'Poll interval in ms. Default 3000ms; minimum 1000ms.',
        },
      },
    },
  },
  {
    name: 'submit_review',
    description:
      'USE THIS WHEN a packet is awaiting_review and you\'ve inspected the diff (via o8_merge_preview or by reading the worktree). approved:true unlocks the F18 auto-merge path; approved:false sends the packet back to the agent with findings as feedback. Findings are relayed to downstream dependent packets. Use status for the finding enum (fixed, accepted, deferred); put free-text fix details in description or fixSuggestion. Example: submit_review({packetId: "pkt-abc", approved: false, findings: [{file: "src/foo.ts", severity: "warning", description: "CSS shorthand used", status: "fixed", fixSuggestion: "Use paddingTop and paddingLeft instead."}]})',
    inputSchema: {
      type: 'object',
      properties: {
        packetId: {
          type: 'string',
          description: 'The packet ID being reviewed.',
        },
        findings: {
          type: 'array',
          description: 'Review findings to persist.',
          items: {
            type: 'object',
            properties: {
              file: { type: 'string' },
              line: { type: 'number' },
              severity: { type: 'string' },
              description: { type: 'string' },
              status: {
                type: 'string',
                enum: ['fixed', 'accepted', 'deferred'],
                description: 'Finding status enum. Use fixSuggestion or description for free-text fix details.',
              },
              resolution: {
                type: 'string',
                enum: ['fixed', 'accepted', 'deferred'],
                description: 'Deprecated alias for status. Do not use for free-text fix details.',
              },
              fixSuggestion: {
                type: 'string',
                description: 'Optional free-text fix narrative.',
              },
            },
            required: ['file', 'severity', 'description'],
          },
        },
        approved: {
          type: 'boolean',
          description: 'Whether the review approved the packet for merge.',
        },
        reviewedHeadSha: {
          type: 'string',
          description: 'Optional worktree HEAD SHA that was reviewed. If omitted, o8 captures the lane worktree HEAD at review time.',
        },
        contractCoverageEvidence: CONTRACT_COVERAGE_EVIDENCE_SCHEMA,
        directivesApplied: {
          type: 'array',
          description: '#732 — Directives the diff RESPECTED. List the directive title or filename (as returned by get_packet_scope). Surfaces in the Packet Review Card so the operator can see governance enforcement.',
          items: { type: 'string' },
        },
        directivesViolated: {
          type: 'array',
          description: '#732 — Directives the diff CONTRADICTED. Each entry names the directive plus the offending file:line. Surfaces in the Packet Review Card as warning rows.',
          items: {
            type: 'object',
            properties: {
              directive: { type: 'string', description: 'Directive title or filename (from get_packet_scope).' },
              file: { type: 'string', description: 'Path of the file where the violation was found.' },
              line: { type: 'number', description: 'Line number of the violating change.' },
              snippet: { type: 'string', description: 'Optional one-line snippet showing the violation.' },
            },
            required: ['directive'],
          },
        },
      },
      required: ['packetId', 'findings', 'approved'],
    },
  },
  {
    name: 'reset_packet',
    description:
      'USE THIS WHEN a packet is stuck (lane status stuck in launching, session_lost, failed, recovering) or the agent produced bad output you want to wipe and try again. Archives the old lane + session AND removes the worktree dir by default. Pass clearWorktree:false to keep the worktree (rare — use retry_packet instead if you want to preserve work). Call dispatch_mission() after to re-launch. Example: reset_packet({packetId: "pkt-abc", reason: "agent timed out"})',
    inputSchema: {
      type: 'object',
      properties: {
        packetId: {
          type: 'string',
          description: 'The packet ID to reset.',
        },
        reason: {
          type: 'string',
          description: 'Optional reason for the reset (e.g., "worktree lost", "agent failed").',
        },
        clearWorktree: {
          type: 'boolean',
          description: 'Also prune the old worktree directory after resetting.',
        },
      },
      required: ['packetId'],
    },
  },
  {
    name: 'retry_packet',
    description:
      'USE THIS WHEN a packet is in session_lost / failed / recovering and you want to RESUME the existing worktree. Archives the old lane + session, KEEPS the worktree dir, then needs dispatch_mission() to relaunch. Pass clearWorktree:true to wipe (or use reset_packet instead). Example: retry_packet({packetId: "pkt-abc", reason: "session_lost"})',
    inputSchema: {
      type: 'object',
      properties: {
        packetId: {
          type: 'string',
          description: 'The packet ID to retry.',
        },
        reason: {
          type: 'string',
          description: 'Optional reason for the retry (e.g., "worktree lost", "agent failed").',
        },
        clearWorktree: {
          type: 'boolean',
          description: 'Also prune the old worktree directory after resetting.',
        },
      },
      required: ['packetId'],
    },
  },
  {
    name: 'o8_review_state',
    description:
      'Get the canonical review state for a packet. Returns working|ready-to-merge|needs-revision|merged|failed plus the latest orchestrator review verdict and merge-gate verdict. Poll this to know when a packet is safe to approve_and_merge. Example: o8_review_state({packetId: "pkt-abc"}) returns {state, orchestratorReview, mergeGate, lane, branch}.',
    inputSchema: {
      type: 'object',
      properties: {
        packetId: {
          type: 'string',
          description: 'The packet ID to read state for.',
        },
      },
      required: ['packetId'],
    },
  },
  {
    name: 'report_packet_event',
    description:
      'Report structured packet progress, blockers, or questions from a worker agent. Use event:"blocked" or event:"question" to move the lane to awaiting_orchestrator; event:"progress" appends history only. Example: report_packet_event({packetId: "pkt-abc", event: "blocked", reason: "needs_clarification", message: "Which auth provider should this target?"})',
    inputSchema: {
      type: 'object',
      properties: {
        packetId: {
          type: 'string',
          description: 'Packet ID whose active lane should receive the report.',
        },
        event: {
          type: 'string',
          description: 'Free-form report event. blocked/question update lane status; progress only records an event.',
        },
        reason: {
          type: 'string',
          enum: [
            'needs_clarification',
            'missing_context',
            'out_of_scope',
            'dependency_blocked',
            'context_full',
            'nondeterministic_test',
            'external_api_down',
            'unknown',
          ],
          description: 'Optional codified reason for the report.',
        },
        message: {
          type: 'string',
          description: 'Optional human-readable detail.',
        },
        metadata: {
          type: 'object',
          description: 'Optional structured metadata to attach to the report.',
        },
      },
      required: ['packetId', 'event'],
    },
  },
  {
    name: 'rerun_with_feedback',
    description:
      'Re-dispatch a rejected packet with appended feedback. Use after submit_review with approved:false records findings — this tool feeds those findings back into the packet body and re-queues for dispatch. The packet keeps its lane history; Codex picks up where it left off with the corrections in scope. Example: rerun_with_feedback({packetId: "pkt-abc", feedback: "Replace webview.eval with app.emit() — security gate blocks eval."})',
    inputSchema: {
      type: 'object',
      properties: {
        packetId: {
          type: 'string',
          description: 'The packet ID to rerun with feedback.',
        },
        feedback: {
          type: 'string',
          description: 'Free-text feedback to append to the packet body for the next dispatch.',
        },
      },
      required: ['packetId', 'feedback'],
    },
  },
];

function parseExistingBranchPolicy(value: unknown): ExistingBranchPolicy | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === 'auto' || value === 'reset' || value === 'continue' || value === 'error') {
    return value;
  }
  throw new Error('existingBranchPolicy must be one of: auto, reset, continue, error.');
}

function parseWorkerIntent(value: unknown): WorkerIntent | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (
    value === 'light_worker'
    || value === 'heavy_worker'
    || value === 'reviewer'
    || value === 'diagnostic'
    || value === 'orchestrator'
  ) {
    return value;
  }
  throw new Error('workerIntent must be one of: light_worker, heavy_worker, reviewer, diagnostic, orchestrator.');
}

function parseWorkerProvider(value: unknown): WorkerProvider | null | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === 'minimax' || isRuntimeWorkerProvider(value)) return value;
  throw new Error(`requestedProvider must be one of: ${WORKER_PROVIDER_OPTIONS.join(', ')}.`);
}

export async function handleCreateMission(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const repoPath = requiredString(args, 'repoPath');
    const runtime = parseMissionRuntime(args.runtime);
    const workerIntent = parseWorkerIntent(args.workerIntent);
    const requestedProvider = parseWorkerProvider(args.requestedProvider);
    const constraints = optionalString(args, 'constraints');

    // #453 — Support inline issues (no GitHub dependency)
    const inlineIssues = Array.isArray(args.issues_inline) ? args.issues_inline : null;
    const ghIssues = Array.isArray(args.issues) && args.issues.length > 0 ? args.issues : null;

    if (!inlineIssues && !ghIssues) {
      return textResult('Provide either `issues` (GitHub refs) or `issues_inline` (inline objects).', true);
    }

    const shouldDispatch = args.dispatch !== false;
    const sequential = args.sequential === true;
    const existingBranchPolicy = parseExistingBranchPolicy(args.existingBranchPolicy);
    const useBrain = typeof args.useBrain === 'boolean' ? args.useBrain : undefined;
    const huddle = typeof args.huddle === 'boolean' ? args.huddle : undefined;
    // #1329 — session-rule inheritance. When the orchestrator passes its active
    // thread id, workers inherit that thread's operator session rules.
    const orchestratorThreadId = optionalString(args, 'orchestratorThreadId') || undefined;
    const candidateMode = parseMissionCandidateMode(args, huddle);
    if (!candidateMode.ok) return textResult(candidateMode.error, true);
    const { comparisonModels, qualitySearch } = candidateMode;

    if (inlineIssues) {
      // #453 — Auto-assign synthetic numbers when not provided. Centralized so
      // every inline creator uses the same collision-resistant allocator.
      const syntheticNumbers = nextInlineIssueNumbers(inlineIssues.length);
      const parsed = inlineIssues.map((entry, index) => {
        if (typeof entry !== 'object' || entry === null) throw new Error('Each inline issue must be an object.');
        const e = entry as Record<string, unknown>;
        const title = typeof e.title === 'string' ? e.title.trim() : '';
        if (!title) throw new Error('Each inline issue must have a title.');
        const syntheticNumber = syntheticNumbers[index]!;
        return { number: syntheticNumber, title, body: typeof e.body === 'string' ? e.body : '' };
      });
      const createResult = await createMissionInline({
        issues_inline: parsed,
        repoPath,
        runtime,
        workerIntent,
        requestedProvider,
        requestedRuntime: runtime,
        constraints,
        sequential,
        existingBranchPolicy,
        useBrain,
        huddle,
        comparisonModels,
        qualitySearch,
        orchestratorThreadId,
      });
      if (shouldDispatch && createResult && !('error' in createResult)) {
        // Fire-and-forget: dispatch can take 30–60s on its own, and the
        // combined create+dispatch path often exceeds the MCP client's
        // tool-call timeout (~60s), which closes the transport while the
        // backend is still processing. Return the create result immediately
        // so the caller gets a clean response, and run dispatch in the
        // background. Callers can poll get_mission_status for progress.
        void dispatchMission({ missionId: createResult.missionId }).catch((err) => {
          console.error('[mcp-operator] background dispatch failed', errorText(err));
        });
        return jsonResult({
          ...createResult,
          dispatch: { queued: true, note: 'Dispatch running in background. Use get_mission_status to poll.' },
        });
      }
      return jsonResult(createResult);
    }

    const createResult = await createMission({
      issues: parseIssueList(args.issues),
      repoPath,
      runtime,
      workerIntent,
      requestedProvider,
      requestedRuntime: runtime,
      constraints,
      sequential,
      existingBranchPolicy,
      useBrain,
      huddle,
      comparisonModels,
      qualitySearch,
      orchestratorThreadId,
    });
    if (shouldDispatch && createResult && !('error' in createResult)) {
      void dispatchMission({ missionId: createResult.missionId }).catch((err) => {
        console.error('[mcp-operator] background dispatch failed', errorText(err));
      });
      return jsonResult({
        ...createResult,
        dispatch: { queued: true, note: 'Dispatch running in background. Use get_mission_status to poll.' },
      });
    }
    return jsonResult(createResult);
  } catch (error) {
    console.error(`${'[mcp-operator]'} create_mission failed: ${errorText(error)}`);
    return textResult(`Failed to create mission: ${errorText(error)}`, true);
  }
}

export async function handleDispatchMission(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const result = await dispatchMission({
      missionId: optionalString(args, 'missionId') || undefined,
    });
    return jsonResult(result);
  } catch (error) {
    console.error(`${'[mcp-operator]'} dispatch_mission failed: ${errorText(error)}`);
    return textResult(`Failed to dispatch mission: ${errorText(error)}`, true);
  }
}

export async function handleGetMissionStatus(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const includeCost = typeof args.includeCost === 'boolean' ? args.includeCost : false;
    const result = await getMissionStatus({
      missionId: optionalString(args, 'missionId') || undefined,
      includeCost,
    });
    return jsonResult(result);
  } catch (error) {
    console.error(`${'[mcp-operator]'} get_mission_status failed: ${errorText(error)}`);
    return textResult(`Failed to read mission status: ${errorText(error)}`, true);
  }
}

export async function handleMissionTail(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const packetId = requiredString(args, 'packetId');
    const sinceRaw = args.since;
    const since = typeof sinceRaw === 'number' && Number.isFinite(sinceRaw) && sinceRaw >= 0
      ? Math.floor(sinceRaw)
      : 0;
    const timeoutRaw = args.timeoutMs;
    const timeoutMs = typeof timeoutRaw === 'number' && Number.isFinite(timeoutRaw) && timeoutRaw > 0
      ? Math.floor(timeoutRaw)
      : 0;

    const qs = new URLSearchParams();
    qs.set('since', String(since));
    if (timeoutMs > 0) {
      qs.set('follow', 'true');
      qs.set('timeoutMs', String(timeoutMs));
    }

    const data = await apiFetch(`/api/lanes/${encodeURIComponent(packetId)}/events?${qs.toString()}`) as Record<string, unknown>;
    const events = Array.isArray(data.events) ? data.events as Array<Record<string, unknown>> : [];
    const nextSinceRaw = data.nextSince;
    const nextSince = typeof nextSinceRaw === 'number' && Number.isFinite(nextSinceRaw)
      ? nextSinceRaw
      : since;
    return jsonResult({
      summary: events.length === 0
        ? `No packet events (nextSince: ${nextSince})`
        : `${events.length} packet events (nextSince: ${nextSince})`,
      data: {
        packetId,
        events,
        nextSince,
      },
    });
  } catch (error) {
    console.error(`${'[mcp-operator]'} mission_tail failed: ${errorText(error)}`);
    return textResult(`Failed to read mission tail: ${errorText(error)}`, true);
  }
}

export async function handleGetPacketScope(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const packetId = optionalString(args, 'packetId') || undefined;
    const laneId = optionalString(args, 'laneId') || undefined;
    if (!packetId && !laneId) {
      return textResult('packetId or laneId is required', true);
    }

    const result = await getPacketScope({ packetId, laneId });
    if (!result) {
      return textResult('Packet scope not found', true);
    }
    // Bound directive prose so a project with many/long directives doesn't
    // flood the worker's context — keep every directive, cap each body.
    const DIRECTIVE_BODY_CAP = 600;
    const scope = result as unknown as Record<string, unknown>;
    if (Array.isArray(scope.directives)) {
      scope.directives = (scope.directives as Array<Record<string, unknown>>).map((directive) => {
        const body = directive.body;
        return typeof body === 'string' && body.length > DIRECTIVE_BODY_CAP
          ? { ...directive, body: `${body.slice(0, DIRECTIVE_BODY_CAP)}…[+${body.length - DIRECTIVE_BODY_CAP} chars truncated]` }
          : directive;
      });
    }
    return jsonResult(scope);
  } catch (error) {
    console.error(`${'[mcp-operator]'} get_packet_scope failed: ${errorText(error)}`);
    return textResult(`Failed to read packet scope: ${errorText(error)}`, true);
  }
}

export async function handlePacketDiff(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const packetId = optionalString(args, 'packetId') || undefined;
    const laneId = optionalString(args, 'laneId') || undefined;
    const id = laneId || packetId;
    if (!id) {
      return textResult('packetId or laneId is required', true);
    }
    const maxBytes = typeof args.maxBytes === 'number' && Number.isFinite(args.maxBytes) && args.maxBytes > 0
      ? Math.floor(args.maxBytes)
      : undefined;
    const qs = maxBytes ? `?maxBytes=${maxBytes}` : '';
    const data = await apiFetch(`/api/lanes/${encodeURIComponent(id)}/diff${qs}`, { acceptedErrorStatuses: [409] });
    return { ...jsonResult(data), isError: Boolean(data && typeof data === 'object' && 'error' in (data as Record<string, unknown>)) };
  } catch (error) {
    console.error(`${'[mcp-operator]'} o8_packet_diff failed: ${errorText(error)}`);
    return textResult(`Failed to read packet diff: ${errorText(error)}`, true);
  }
}

export async function handleTaskList(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const projectId = optionalString(args, 'projectId') || null;
    const repoPath = optionalString(args, 'repoPath') || null;
    const includeDone = args.includeDone === true;
    const includeBrief = args.includeBrief === true;
    const result = await getTaskPool({ projectId, repoPath, includeDone, includeBrief });
    return jsonResult(result);
  } catch (error) {
    console.error(`${'[mcp-operator]'} o8_task_list failed: ${errorText(error)}`);
    return textResult(`Failed to read task pool: ${errorText(error)}`, true);
  }
}

export async function handleTaskCreate(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const allowedFiles = Array.isArray(args.allowedFiles)
      ? args.allowedFiles.map((entry) => (typeof entry === 'string' ? entry.trim() : '')).filter(Boolean)
      : null;
    const result = await createTask({
      actor: 'orchestrator',
      title: requiredString(args, 'title'),
      summary: optionalString(args, 'summary') || null,
      projectId: optionalString(args, 'projectId') || null,
      repoPath: optionalString(args, 'repoPath') || null,
      model: optionalString(args, 'model') || null,
      workerIntent: optionalString(args, 'workerIntent') || null,
      requestedProvider: optionalString(args, 'requestedProvider') || null,
      requestedRuntime: optionalString(args, 'requestedRuntime') || null,
      allowedFiles,
    });
    return jsonResult(result);
  } catch (error) {
    console.error(`${'[mcp-operator]'} o8_task_create failed: ${errorText(error)}`);
    return textResult(`Failed to create task: ${errorText(error)}`, true);
  }
}

export async function handleTaskBrief(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const taskId = requiredString(args, 'taskId');
    const projectId = optionalString(args, 'projectId') || null;
    const repoPath = optionalString(args, 'repoPath') || null;
    const task = await getTaskPoolTask(taskId, { projectId, repoPath });
    if (!task) {
      return textResult('Task not found', true);
    }
    return jsonResult({
      schema: 'o8/task.detail/v1',
      task,
    });
  } catch (error) {
    console.error(`${'[mcp-operator]'} o8_task_brief failed: ${errorText(error)}`);
    return textResult(`Failed to read task brief: ${errorText(error)}`, true);
  }
}

export async function handleTaskClaim(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const result = await claimTask(requiredString(args, 'taskId'), {
      actor: 'orchestrator',
      note: optionalString(args, 'note') || null,
      projectId: optionalString(args, 'projectId') || null,
      repoPath: optionalString(args, 'repoPath') || null,
    });
    return jsonResult(result);
  } catch (error) {
    console.error(`${'[mcp-operator]'} o8_task_claim failed: ${errorText(error)}`);
    return textResult(`Failed to claim task: ${errorText(error)}`, true);
  }
}

export async function handleTaskDispatch(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const result = await dispatchTask(requiredString(args, 'taskId'), {
      actor: 'orchestrator',
      message: optionalString(args, 'message') || null,
      model: optionalString(args, 'model') || null,
      workerIntent: optionalString(args, 'workerIntent') || null,
      requestedProvider: optionalString(args, 'requestedProvider') || null,
      requestedRuntime: optionalString(args, 'requestedRuntime') || null,
      projectId: optionalString(args, 'projectId') || null,
      repoPath: optionalString(args, 'repoPath') || null,
    });
    return jsonResult(result);
  } catch (error) {
    console.error(`${'[mcp-operator]'} o8_task_dispatch failed: ${errorText(error)}`);
    return textResult(`Failed to dispatch task: ${errorText(error)}`, true);
  }
}

export async function handleTaskBlock(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const code = optionalString(args, 'code') || undefined;
    if (code !== undefined && !isAgentReportReason(code)) {
      throw new Error('code must be one of: needs_clarification, missing_context, out_of_scope, dependency_blocked, context_full, nondeterministic_test, external_api_down, unknown.');
    }
    const result = await blockTask(requiredString(args, 'taskId'), {
      actor: 'orchestrator',
      reason: requiredString(args, 'reason'),
      code,
      projectId: optionalString(args, 'projectId') || null,
      repoPath: optionalString(args, 'repoPath') || null,
    });
    return jsonResult(result);
  } catch (error) {
    console.error(`${'[mcp-operator]'} o8_task_block failed: ${errorText(error)}`);
    return textResult(`Failed to block task: ${errorText(error)}`, true);
  }
}

export async function handleTaskReport(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const reason = optionalString(args, 'reason') || undefined;
    if (reason !== undefined && !isAgentReportReason(reason)) {
      throw new Error('reason must be one of: needs_clarification, missing_context, out_of_scope, dependency_blocked, context_full, nondeterministic_test, external_api_down, unknown.');
    }
    const metadata = args.metadata === undefined || args.metadata === null
      ? undefined
      : normalizeAgentReportMetadata(args.metadata);
    if (args.metadata !== undefined && args.metadata !== null && !metadata) {
      throw new Error('metadata must be an object');
    }
    const result = await reportTask(requiredString(args, 'taskId'), {
      actor: 'orchestrator',
      event: optionalString(args, 'event') || null,
      status: optionalString(args, 'status') || null,
      reason,
      message: optionalString(args, 'message') || null,
      metadata: metadata ?? null,
      projectId: optionalString(args, 'projectId') || null,
      repoPath: optionalString(args, 'repoPath') || null,
    });
    return jsonResult(result);
  } catch (error) {
    console.error(`${'[mcp-operator]'} o8_task_report failed: ${errorText(error)}`);
    return textResult(`Failed to report task: ${errorText(error)}`, true);
  }
}

export async function handleTaskArchive(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const result = await archiveTask(requiredString(args, 'taskId'), {
      actor: 'orchestrator',
      reason: optionalString(args, 'reason') || null,
      projectId: optionalString(args, 'projectId') || null,
      repoPath: optionalString(args, 'repoPath') || null,
    });
    return jsonResult(result);
  } catch (error) {
    console.error(`${'[mcp-operator]'} o8_task_archive failed: ${errorText(error)}`);
    return textResult(`Failed to archive task: ${errorText(error)}`, true);
  }
}

export async function handleTaskPrune(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const result = await pruneTask(requiredString(args, 'taskId'), {
      actor: 'orchestrator',
      reason: optionalString(args, 'reason') || null,
      projectId: optionalString(args, 'projectId') || null,
      repoPath: optionalString(args, 'repoPath') || null,
    });
    return jsonResult(result);
  } catch (error) {
    console.error(`${'[mcp-operator]'} o8_task_prune failed: ${errorText(error)}`);
    return textResult(`Failed to prune task: ${errorText(error)}`, true);
  }
}

// Packet states that need the caller's attention — the runtime is done working
// for now and a decision is required. `blocked` belongs here (#1467): it is what
// awaiting_input / awaiting_orchestrator (huddle, #1495) / awaiting_human lanes
// and dispatch failures map to, and none of those progress without a decision.
// Excluding it deadlocked the loop: the orchestrator sat in wait_for_mission_ready
// while its worker sat in awaiting_orchestrator waiting for the orchestrator.
// Dependency-held packets stay `queued` (with blockedBy), so they never
// false-wake this set. `running`, `queued`, `launching` are NOT included.
const PACKET_ATTENTION_STATUSES = new Set(['awaiting_review', 'released', 'failed', 'archived', 'blocked']);

interface MinimalMissionPacket {
  id?: string;
  status?: string;
  releaseState?: string;
  blockedBy?: unknown;
}

interface MinimalMissionStatusShape {
  packets?: MinimalMissionPacket[];
  currentWave?: number;
  totalWaves?: number;
}

function packetSignature(packets: MinimalMissionPacket[] | undefined): string {
  if (!Array.isArray(packets)) return '';
  return packets
    .map((p) => `${p.id ?? ''}:${p.status ?? ''}:${p.releaseState ?? ''}`)
    .sort()
    .join(',');
}

function findTerminalPacket(
  status: MinimalMissionStatusShape,
  packetIdFilter: string | null,
): MinimalMissionPacket | null {
  const packets = status.packets ?? [];
  for (const p of packets) {
    if (packetIdFilter && p.id !== packetIdFilter) continue;
    if (typeof p.status === 'string' && PACKET_ATTENTION_STATUSES.has(p.status)) {
      return p;
    }
  }
  return null;
}

export async function handleWaitForMissionReady(args: Record<string, unknown>, readStatus: typeof getMissionStatus = getMissionStatus): Promise<McpToolResult> {
  const TIMEOUT_DEFAULT_MS = 10 * 60 * 1000;
  const TIMEOUT_MAX_MS = 30 * 60 * 1000;
  const POLL_DEFAULT_MS = 3000;
  const POLL_MIN_MS = 1000;

  const missionId = optionalString(args, 'missionId') || undefined;
  const packetIdFilter = optionalString(args, 'packetId') || null;
  const timeoutInput = typeof args.timeoutMs === 'number' ? args.timeoutMs : TIMEOUT_DEFAULT_MS;
  const timeoutMs = Math.max(1000, Math.min(TIMEOUT_MAX_MS, timeoutInput));
  const pollInput = typeof args.pollIntervalMs === 'number' ? args.pollIntervalMs : POLL_DEFAULT_MS;
  const pollIntervalMs = Math.max(POLL_MIN_MS, pollInput);

  try {
    const baseline = (await readStatus({ missionId, includeCost: false })) as MinimalMissionStatusShape;

    // If a terminal state already exists at baseline, return immediately so
    // the caller never blocks unnecessarily.
    const baselineTerminal = findTerminalPacket(baseline, packetIdFilter);
    if (baselineTerminal) {
      return jsonResult({ ...baseline, wakeReason: 'already-terminal', terminalPacketId: baselineTerminal.id ?? null });
    }

    const baselineSig = packetSignature(baseline.packets);
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      // Sleep first — we just fetched baseline, no point hitting again on tick 0.
      const remaining = deadline - Date.now();
      const wait = Math.min(pollIntervalMs, Math.max(0, remaining));
      if (wait > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, wait));
      }
      if (Date.now() >= deadline) break;

      const next = (await readStatus({ missionId, includeCost: false })) as MinimalMissionStatusShape;
      const terminal = findTerminalPacket(next, packetIdFilter);
      if (terminal) {
        return jsonResult({ ...next, wakeReason: 'state-change', terminalPacketId: terminal.id ?? null });
      }
      if (packetSignature(next.packets) !== baselineSig) {
        return jsonResult({ ...next, wakeReason: 'state-change', terminalPacketId: null });
      }
    }

    const finalSnapshot = (await readStatus({ missionId, includeCost: false })) as MinimalMissionStatusShape;
    return jsonResult({ ...finalSnapshot, wakeReason: 'timeout', terminalPacketId: null });
  } catch (error) {
    console.error(`${'[mcp-operator]'} wait_for_mission_ready failed: ${errorText(error)}`);
    return textResult(`Failed to wait for mission: ${errorText(error)}`, true);
  }
}

export async function handleSubmitReview(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    if (typeof args.approved !== 'boolean') {
      throw new Error('approved is required');
    }
    const result = await submitPacketReview({
      packetId: requiredString(args, 'packetId'),
      findings: parseReviewFindings(args.findings),
      approved: args.approved,
      reviewedHeadSha: optionalString(args, 'reviewedHeadSha') || undefined,
      contractCoverageEvidence: parseContractCoverageEvidenceInput(args.contractCoverageEvidence),
      directivesApplied: parseDirectivesApplied(args.directivesApplied),
      directivesViolated: parseDirectivesViolated(args.directivesViolated),
    });
    return jsonResult(result);
  } catch (error) {
    console.error(`${'[mcp-operator]'} submit_review failed: ${errorText(error)}`);
    return textResult(`Failed to submit review: ${errorText(error)}`, true);
  }
}

// F33 (#1025): reset_packet and retry_packet share an implementation but
// differ in semantics — reset implies "wipe and try again," retry implies
// "preserve and resume." When clearWorktree was uniformly defaulted to false,
// reset_packet without the explicit flag left orphan worktree dirs that
// collided with the next dispatch and produced -<suffix> duplicates on the
// same branch. Splitting the defaults keeps the two verbs honest.
async function doResetPacket(
  args: Record<string, unknown>,
  defaultClearWorktree: boolean,
): Promise<McpToolResult> {
  try {
    const clearWorktree = args.clearWorktree === undefined
      ? defaultClearWorktree
      : args.clearWorktree === true;
    const result = await resetPacket({
      packetId: requiredString(args, 'packetId'),
      reason: optionalString(args, 'reason') || undefined,
      clearWorktree,
    });
    return jsonResult(result);
  } catch (error) {
    console.error(`${'[mcp-operator]'} reset/retry failed: ${errorText(error)}`);
    return textResult(`Failed to reset packet: ${errorText(error)}`, true);
  }
}

export async function handleResetPacket(args: Record<string, unknown>): Promise<McpToolResult> {
  return doResetPacket(args, /* default clearWorktree */ true);
}

export async function handleRetryPacket(args: Record<string, unknown>): Promise<McpToolResult> {
  return doResetPacket(args, /* default clearWorktree */ false);
}

export async function handleRerunWithFeedback(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const result = await rerunWithFeedback({
      packetId: requiredString(args, 'packetId'),
      feedback: requiredString(args, 'feedback'),
    });
    return jsonResult(result);
  } catch (error) {
    console.error(`${'[mcp-operator]'} rerun_with_feedback failed: ${errorText(error)}`);
    return textResult(`Failed to rerun with feedback: ${errorText(error)}`, true);
  }
}

interface ReportLane {
  id: string;
  packetId: string | null;
}

export async function handleReportPacketEvent(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const packetId = requiredString(args, 'packetId');
    const event = normalizeAgentReportEvent(args.event);
    if (!event) {
      throw new Error('event is required');
    }

    const reason = optionalString(args, 'reason') || undefined;
    if (reason !== undefined && !isAgentReportReason(reason)) {
      throw new Error('reason must be one of: needs_clarification, missing_context, out_of_scope, dependency_blocked, context_full, nondeterministic_test, external_api_down, unknown.');
    }

    const lanesResult = await apiFetch('/api/lanes?active=false') as { lanes?: ReportLane[] };
    const lane = (lanesResult.lanes ?? []).find((candidate) => candidate.packetId === packetId);
    if (!lane) {
      return textResult(`No lane found for packet ${packetId}.`, true);
    }

    const metadata = args.metadata === undefined || args.metadata === null
      ? undefined
      : normalizeAgentReportMetadata(args.metadata);
    if (args.metadata !== undefined && args.metadata !== null && !metadata) {
      throw new Error('metadata must be an object');
    }

    const result = await apiFetch(`/api/lanes/${encodeURIComponent(lane.id)}/events`, {
      method: 'POST',
      body: JSON.stringify({
        verb: 'agent_report',
        event,
        reason,
        message: normalizeAgentReportMessage(args.message),
        metadata,
      }),
    }) as Record<string, unknown>;

    if (result.ok === false) {
      return textResult(String(result.note ?? `Failed to report event for ${packetId}.`), true);
    }

    return jsonResult({
      summary: `Reported ${event} for ${packetId}.`,
      data: result,
    });
  } catch (error) {
    console.error(`${'[mcp-operator]'} report_packet_event failed: ${errorText(error)}`);
    return textResult(`Failed to report packet event: ${errorText(error)}`, true);
  }
}

export async function handleReviewState(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const packetId = requiredString(args, 'packetId');
    const result = await apiFetch(`/api/orchestrator/review-state?packetId=${encodeURIComponent(packetId)}`);
    return jsonResult(result);
  } catch (error) {
    console.error(`${'[mcp-operator]'} o8_review_state failed: ${errorText(error)}`);
    return textResult(`Failed to read review state: ${errorText(error)}`, true);
  }
}
