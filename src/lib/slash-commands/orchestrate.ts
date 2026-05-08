import type { OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';
import { buildSlashCommandEntry, collectRecentDecisionLines } from './shared';
import type { ParsedOrchestratorSlashCommand, SlashCommandContext, SlashCommandExecutionResult } from './types';

const MAX_GOAL_LENGTH = 4_000;
const MAX_CONTEXT_LINE_LENGTH = 260;

function truncate(value: string, limit = MAX_CONTEXT_LINE_LENGTH) {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function repoLabel(repoPath: string | null) {
  if (!repoPath?.trim()) return 'repo not selected';
  return repoPath.split('/').filter(Boolean).pop() || repoPath;
}

function activePacketLines(missionState: OrchestratorMissionState) {
  return missionState.packets
    .filter((packet) => packet.status !== 'archived' && packet.status !== 'released')
    .slice(0, 4)
    .map((packet: OrchestratorPacket) => {
      const runtime = packet.lane?.runtime ?? packet.runtime;
      const laneStatus = packet.lane?.lastEventLabel || packet.status;
      return `${packet.referenceLabel}: ${truncate(packet.title, 90)} (${packet.status}; ${runtime}; ${laneStatus})`;
    });
}

function buildSlashOrchestrationPrompt(input: {
  goal: string;
  repoPath: string | null;
  missionState: OrchestratorMissionState;
  recentDecisions: string[];
}) {
  const activePackets = activePacketLines(input.missionState);
  const goal = truncate(input.goal, MAX_GOAL_LENGTH);
  const missionSummary = truncate(input.missionState.summary || input.missionState.prompt || 'No active mission summary.', 420);

  return [
    '<slash_orchestrate_request>',
    `Invocation: explicit /orchestrate slash command`,
    `User goal: ${goal}`,
    `Target repo: ${input.repoPath?.trim() || 'not selected'}`,
    '',
    'Role contract:',
    '- You are Claude, the planner, coordinator, and verifier for this request.',
    '- Use Codex for coding lanes. Codex is the default worker for implementation tasks.',
    '- Do not dispatch claude-code as a worker. Claude verification happens through this orchestrator session and the existing review flow.',
    '- Use Gemini or opencode only if the user explicitly asks or Codex is unavailable.',
    '',
    'Dispatch policy:',
    '- Keep this chat clean and inline. Do not open a separate planning board.',
    '- Prefer one broad Codex worker. Use at most three workers unless the task has truly independent slices.',
    '- If the task is small enough to do directly, do it inline instead of dispatching.',
    '- If you dispatch, include concrete scope, expected behavior, file/path hints, and verification expectations in each worker prompt.',
    '- If you create mission packets or lanes, set the implementation runtime to codex unless the operator explicitly requests another runtime.',
    '- Once a worker is dispatched, stop reading files for that worker slice in this turn unless dispatch failed.',
    '',
    'Verification policy:',
    '- Treat Claude as the verifier. Review Codex work independently before merge/release.',
    '- Use the existing lane review, approval, and merge gate flow for completed worker lanes.',
    '- Do not mark work complete from worker self-review alone.',
    '',
    'Token policy:',
    '- Do not restate this contract to the operator.',
    '- Do not paste long plans into chat. Give a compact action summary.',
    '- Do not include the full transcript. Use the existing session context plus the concise context below.',
    '',
    'Current compact context:',
    `- Mission: ${missionSummary}`,
    activePackets.length > 0 ? `- Active packets: ${activePackets.join(' | ')}` : '- Active packets: none',
    input.recentDecisions.length > 0 ? `- Recent decisions: ${input.recentDecisions.map((line) => truncate(line, 180)).join(' | ')}` : '- Recent decisions: none',
    '',
    'Act now in this same turn: decide whether to dispatch Codex worker lane(s), execute the dispatch if warranted, and end with a concise operator-facing status.',
    '</slash_orchestrate_request>',
  ].join('\n');
}

export async function handleOrchestrateSlashCommand(
  command: ParsedOrchestratorSlashCommand,
  context: SlashCommandContext,
): Promise<SlashCommandExecutionResult> {
  const task = command.args.trim();
  if (!task) {
    context.appendEntries([
      buildSlashCommandEntry({
        name: 'orchestrate',
        summary: 'Orchestrate needs a task to coordinate.',
        details: ['Example: /orchestrate fix the failing browser smoke and report the diff'],
        chips: [{ label: 'argument required', tone: 'amber' }],
      }),
    ]);
    return { handled: true };
  }

  if (!context.startOrchestration) {
    context.appendEntries([
      buildSlashCommandEntry({
        name: 'orchestrate',
        summary: 'Orchestration start is not available in this surface.',
        details: ['Use the main Fleet chat composer to run /orchestrate.'],
        chips: [{ label: 'unavailable', tone: 'red' }],
      }),
    ]);
    return { handled: true };
  }

  const prompt = buildSlashOrchestrationPrompt({
    goal: task,
    repoPath: context.repoPath,
    missionState: context.missionState,
    recentDecisions: collectRecentDecisionLines(context.transcript, 3),
  });

  await context.startOrchestration({
    goal: task,
    rawCommand: command.raw,
    displayMessage: command.raw,
    prompt,
    commandEntry: buildSlashCommandEntry({
      name: 'orchestrate',
      summary: `Started orchestration for ${repoLabel(context.repoPath)}.`,
      details: [
        `Goal: ${truncate(task, 220)}`,
        'Default lane model: Claude plans and verifies; Codex implements.',
        'Worker policy: one broad Codex lane by default, three max unless explicitly justified.',
      ],
      chips: [
        { label: 'explicit slash', tone: 'blue' },
        { label: 'Codex worker', tone: 'amber' },
        { label: 'Claude verifier', tone: 'emerald' },
      ],
    }),
  });

  return { handled: true };
}
