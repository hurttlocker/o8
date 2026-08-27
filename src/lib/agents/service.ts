import 'server-only';

import { resolve } from 'node:path';

import type Database from 'better-sqlite3';

import type { RequestPrincipalContext } from '@/lib/auth/principal';
import { codename } from '@/lib/agents/codename';
import { getSqlite } from '@/lib/db';
import { findLaneByPacket, getLane } from '@/lib/lane/registry';
import type { Lane } from '@/lib/lane/types';
import {
  type AgentMessageDeliverySeams,
  defaultAgentMessageDeliverySeams,
  deliverAgentMessage,
} from './delivery';
import {
  availableAutomaticAgentName,
  type LiveAgentPresenceSeams,
  defaultLiveAgentPresenceSeams,
  reconcileLiveAgentPresence,
} from './live-presence';
import {
  AGENT_MESSAGE_TEXT_MAX_LENGTH,
  type AgentMessageRefs,
  type AgentPresence,
  acknowledgeAgentInbox,
  findAgentPresence,
  isPresenceLive,
  listAgentInbox,
  listAgentPresence,
  listRecentAgentMessages,
  persistAgentMessage,
  updateAgentMessageDelivery,
  upsertAgentPresence,
} from './store';

const LABEL_MAX_LENGTH = 160;

export class AgentBusError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'AgentBusError';
  }
}

function objectInput(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentBusError('A JSON object is required.', code, 400);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string, maxLength = LABEL_MAX_LENGTH): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AgentBusError(`${name} is required.`, `invalid_${name}`, 400);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new AgentBusError(`${name} must be at most ${maxLength} characters.`, `invalid_${name}`, 400);
  }
  return normalized;
}

function optionalString(value: unknown, name: string, maxLength = LABEL_MAX_LENGTH): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new AgentBusError(`${name} must be a string.`, `invalid_${name}`, 400);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new AgentBusError(`${name} must be at most ${maxLength} characters.`, `invalid_${name}`, 400);
  }
  return normalized || null;
}

function lanePresence(lane: Lane, lastSeen: string): AgentPresence {
  return {
    agentId: lane.id,
    name: codename(lane.id),
    repo: lane.repoPath,
    worktreePath: lane.worktreePath,
    runtime: lane.runtime,
    sessionKey: lane.sessionKey,
    laneId: lane.id,
    packetId: lane.packetId,
    lastSeen,
  };
}

export function heartbeatAgentPresence(
  lane: Lane,
  heartbeatAt: number,
  sqlite: Database.Database = getSqlite(),
): AgentPresence {
  return upsertAgentPresence(lanePresence(lane, new Date(heartbeatAt).toISOString()), sqlite);
}

function requireBusPrincipal(principal: RequestPrincipalContext): void {
  if (principal.role !== 'operator' && principal.role !== 'worker') {
    throw new AgentBusError(
      'Agent messaging requires an operator or packet-bound worker credential.',
      'agent_bus_forbidden',
      403,
    );
  }
  if (principal.role === 'worker' && !principal.packetId) {
    throw new AgentBusError('Worker credential is not packet-bound.', 'agent_bus_packet_required', 403);
  }
}

function workerLane(principal: RequestPrincipalContext): Lane | null {
  return principal.role === 'worker' && principal.packetId
    ? findLaneByPacket(principal.packetId)
    : null;
}

function messageRefs(body: Record<string, unknown>, lane: Lane | null): AgentMessageRefs {
  const refs = body.refs && typeof body.refs === 'object' && !Array.isArray(body.refs)
    ? body.refs as Record<string, unknown>
    : {};
  return {
    laneId: lane?.id ?? optionalString(refs.laneId, 'laneId'),
    packetId: lane?.packetId ?? optionalString(refs.packetId, 'packetId'),
  };
}

function normalizedAgentAlias(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_]+/g, '-');
}

function presenceMatchesRuntimeAlias(presence: AgentPresence, target: string): boolean {
  const runtime = normalizedAgentAlias(presence.runtime);
  return target === runtime || target === runtime.split('-')[0];
}

function resolveAgentTarget(
  to: string,
  repo: string | null,
  sqlite: Database.Database,
): AgentPresence | null {
  const exact = findAgentPresence({ name: to, repo }, sqlite);
  if (exact && isPresenceLive(exact)) return exact;
  if (!repo) return exact;

  const alias = normalizedAgentAlias(to);
  const candidates = listAgentPresence(repo, {}, sqlite)
    .filter((presence) => presenceMatchesRuntimeAlias(presence, alias));
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    throw new AgentBusError(
      `Agent name ${to} is ambiguous in that repository. Use one of: ${candidates.map((candidate) => candidate.name).join(', ')}.`,
      'agent_target_ambiguous',
      409,
    );
  }
  return exact;
}

export async function postAgentMessage(
  input: unknown,
  principal: RequestPrincipalContext,
  seams: AgentMessageDeliverySeams = defaultAgentMessageDeliverySeams,
  sqlite: Database.Database = getSqlite(),
  presenceSeams: LiveAgentPresenceSeams = defaultLiveAgentPresenceSeams,
) {
  requireBusPrincipal(principal);
  const body = objectInput(input, 'invalid_agent_message');
  const lane = workerLane(principal);
  if (principal.role === 'worker' && !lane) {
    throw new AgentBusError('The worker packet has no active lane.', 'agent_bus_lane_not_found', 404);
  }
  const to = requiredString(body.to, 'to');
  let repo = optionalString(body.repo, 'repo', 2_000);
  let sender: AgentPresence | null = null;
  if (lane) {
    repo = lane.repoPath;
    sender = upsertAgentPresence(lanePresence(lane, new Date().toISOString()), sqlite);
  } else if (typeof body.fromAgentId === 'string') {
    sender = findAgentPresence({ agentId: body.fromAgentId }, sqlite);
    if (!sender) {
      throw new AgentBusError('Sender has not joined presence.', 'agent_sender_not_found', 404);
    }
    if (repo && sender.repo !== repo) {
      throw new AgentBusError('Sender is not present in that repository.', 'agent_sender_repo_mismatch', 403);
    }
    repo = sender.repo;
  }
  if (repo) await reconcileLiveAgentPresence(repo, presenceSeams, sqlite);
  const target = resolveAgentTarget(to, repo, sqlite);
  if (!target) {
    throw new AgentBusError(
      repo ? `No agent named ${to} is registered in that repository.` : `Agent name ${to} is absent or ambiguous.`,
      'agent_target_not_found',
      404,
    );
  }
  if (lane && target.repo !== lane.repoPath) {
    throw new AgentBusError('Workers can message only agents in their repository.', 'agent_repo_mismatch', 403);
  }
  const text = requiredString(body.text, 'text', AGENT_MESSAGE_TEXT_MAX_LENGTH);
  let message = persistAgentMessage({
    from: sender?.name ?? optionalString(body.from, 'from') ?? 'operator',
    to: target.name,
    repo: target.repo,
    text,
    refs: messageRefs(body, lane),
  }, sqlite);
  if (!isPresenceLive(target)) return message;
  try {
    const result = await deliverAgentMessage(message, target, seams);
    message = updateAgentMessageDelivery(message.id, result.delivery, result.note, sqlite);
  } catch (error) {
    message = updateAgentMessageDelivery(
      message.id,
      'poll',
      `Live delivery deferred; retained in the durable inbox. ${error instanceof Error ? error.message : String(error)}`,
      sqlite,
    );
  }
  return message;
}

export function joinAgentPresence(
  input: unknown,
  principal: RequestPrincipalContext,
  sqlite: Database.Database = getSqlite(),
): AgentPresence {
  if (principal.role !== 'operator') {
    throw new AgentBusError('Presence join requires an operator credential.', 'agent_presence_join_forbidden', 403);
  }
  const body = objectInput(input, 'invalid_agent_presence');
  const agentId = requiredString(body.agentId, 'agentId');
  const repo = requiredString(body.repo, 'repo', 2_000);
  const automatic = body.automatic === true;
  const name = automatic
    ? optionalString(body.name, 'name') ?? availableAutomaticAgentName(agentId, resolve(repo), sqlite)
    : requiredString(body.name, 'name');
  return upsertAgentPresence({
    agentId,
    name,
    repo,
    worktreePath: optionalString(body.worktreePath, 'worktreePath', 2_000),
    runtime: requiredString(body.runtime, 'runtime'),
    sessionKey: optionalString(body.sessionKey, 'sessionKey', 500),
    laneId: null,
    packetId: null,
    lastSeen: new Date().toISOString(),
  }, sqlite);
}

export async function readAgentPresence(
  repo: string | null,
  principal: RequestPrincipalContext,
  sqlite: Database.Database = getSqlite(),
  presenceSeams: LiveAgentPresenceSeams = defaultLiveAgentPresenceSeams,
): Promise<AgentPresence[]> {
  requireBusPrincipal(principal);
  const lane = workerLane(principal);
  if (principal.role === 'worker' && !lane) {
    throw new AgentBusError('The worker packet has no active lane.', 'agent_bus_lane_not_found', 404);
  }
  const requestedRepo = lane?.repoPath ?? requiredString(repo, 'repo', 2_000);
  if (lane && repo && resolve(repo) !== resolve(lane.repoPath)) {
    throw new AgentBusError('Workers can inspect only their repository.', 'agent_repo_mismatch', 403);
  }
  await reconcileLiveAgentPresence(requestedRepo, presenceSeams, sqlite);
  return listAgentPresence(requestedRepo, {}, sqlite);
}

function parseCursor(cursor: string | null): number {
  if (!cursor) return 0;
  try {
    const parsed = Number(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
  } catch {
    // Typed error below.
  }
  throw new AgentBusError('Inbox cursor is invalid.', 'invalid_agent_inbox_cursor', 400);
}

export function readAgentInbox(
  input: { agent: string | null; agentId: string | null; cursor: string | null; limit: number },
  principal: RequestPrincipalContext,
  sqlite: Database.Database = getSqlite(),
) {
  requireBusPrincipal(principal);
  const lane = workerLane(principal);
  const agent = lane
    ? findAgentPresence({ agentId: lane.id }, sqlite)
      ?? upsertAgentPresence(lanePresence(lane, new Date().toISOString()), sqlite)
    : findAgentPresence({ agentId: input.agentId, name: input.agent }, sqlite);
  if (!agent) throw new AgentBusError('Inbox agent was not found.', 'agent_inbox_not_found', 404);
  if (lane && agent.agentId !== lane.id) {
    throw new AgentBusError('Workers can read only their own inbox.', 'agent_inbox_forbidden', 403);
  }
  const after = parseCursor(input.cursor);
  const page = listAgentInbox({ agent, after, limit: input.limit }, sqlite);
  const acknowledgesDelivery = lane !== null || input.agentId !== null;
  if (acknowledgesDelivery) {
    acknowledgeAgentInbox({ agent, throughSequence: page.cursor }, sqlite);
  }
  return {
    agent,
    messages: acknowledgesDelivery
      ? page.messages.map((message) => message.delivery === 'native' ? message : {
        ...message,
        delivery: 'native' as const,
        deliveryNote: 'Read from the durable inbox by the target session.',
      })
      : page.messages,
    cursor: Buffer.from(String(page.cursor), 'utf8').toString('base64url'),
    hasMore: page.hasMore,
  };
}

export function readAgentExchanges(
  input: { repo: string | null; limit: number },
  principal: RequestPrincipalContext,
  sqlite: Database.Database = getSqlite(),
) {
  if (principal.role !== 'operator') {
    throw new AgentBusError(
      'Recent agent exchanges require an operator credential.',
      'agent_exchanges_forbidden',
      403,
    );
  }
  const repo = requiredString(input.repo, 'repo', 2_000);
  return {
    repo: resolve(repo),
    messages: listRecentAgentMessages(repo, input.limit, sqlite),
  };
}

export function laneForPresenceHeartbeat(laneId: string): Lane | null {
  return getLane(laneId);
}
