import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { transcriptScouts } from '../../transcript/activity';
import { transcriptTurns } from '../../transcript/turns';
import { visibleSwarmPackets, type SwarmScoutView, type SwarmSessionView } from './SwarmStatusCard';

export interface ThreadWorkerGroup {
  packets: OrchestratorPacket[];
  sessions: SwarmSessionView[];
  scouts: SwarmScoutView[];
}

const emptyGroup = (): ThreadWorkerGroup => ({ packets: [], sessions: [], scouts: [] });

/** Only exact saved assistant identities can attach workers to a transcript turn. */
export function projectThreadWorkerGroups({ entries, packets, sessions, busy }: {
  entries: MobileTranscriptEntry[];
  packets: OrchestratorPacket[];
  sessions: SwarmSessionView[];
  busy: boolean;
}) {
  const groups = new Map<string, ThreadWorkerGroup>();
  const origins = new Map<string, string>();
  const unattributed = emptyGroup();
  for (const turn of transcriptTurns(entries, busy)) {
    const key = entries[turn.start].id;
    const turnEntries = entries.slice(turn.start, turn.end);
    for (const entry of turnEntries) if (entry.role === 'assistant') origins.set(entry.id, key);
    const scouts = transcriptScouts(turnEntries, busy && turn.end === entries.length);
    if (scouts.length) groups.set(key, { ...emptyGroup(), scouts });
  }
  const groupFor = (origin: string | null | undefined) => {
    const key = origin ? origins.get(origin) : undefined;
    if (!key) return unattributed;
    let group = groups.get(key);
    if (!group) { group = emptyGroup(); groups.set(key, group); }
    return group;
  };
  const visiblePackets = visibleSwarmPackets(packets);
  const sessionOrigins = new Map<string, Set<string>>();
  const recordOrigin = (sessionKey: string | null | undefined, origin: string | null | undefined) => {
    if (!sessionKey || !origin) return;
    const recorded = sessionOrigins.get(sessionKey) ?? new Set<string>();
    recorded.add(origin);
    sessionOrigins.set(sessionKey, recorded);
  };
  for (const session of sessions) recordOrigin(session.sessionKey, session.parentTurnId);
  for (const packet of visiblePackets) recordOrigin(packet.lane?.sessionKey, packet.orchestratorTurnId);
  const sessionOrigin = (sessionKey: string | null | undefined) => {
    const recorded = sessionKey ? sessionOrigins.get(sessionKey) : undefined;
    return recorded?.size === 1 ? [...recorded][0] : undefined;
  };
  for (const packet of visiblePackets) {
    const origin = packet.lane?.sessionKey ? sessionOrigin(packet.lane.sessionKey) : packet.orchestratorTurnId;
    groupFor(origin).packets.push(packet);
  }
  // Conflicting receipts stay unattributed; array order cannot move a worker between turns.
  // A shared session can also appear in a packet receipt. Render that identity once.
  const packetSessions = new Set(visiblePackets.flatMap(packet => [packet.lane?.sessionKey, packet.lane?.tabId]).filter(Boolean));
  for (const session of new Map(sessions.map(session => [session.sessionKey, session])).values()) {
    if (!packetSessions.has(session.sessionKey)) groupFor(sessionOrigin(session.sessionKey)).sessions.push(session);
  }
  return { groups, unattributed };
}
