import type { AgentMessageIdentity, AgentMessageRefs } from './types';

export function parseMessageRefs(value: string): AgentMessageRefs {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const identities = parsed.identities && typeof parsed.identities === 'object' ? parsed.identities as Record<string, unknown> : null;
    const identity = (entry: unknown): AgentMessageIdentity | null => {
      if (!entry || typeof entry !== 'object') return null;
      const candidate = entry as Record<string, unknown>;
      return typeof candidate.runtime === 'string' && (typeof candidate.sessionKey === 'string' || candidate.sessionKey === null)
        ? { runtime: candidate.runtime, sessionKey: candidate.sessionKey } : null;
    };
    return {
      laneId: typeof parsed.laneId === 'string' ? parsed.laneId : null,
      packetId: typeof parsed.packetId === 'string' ? parsed.packetId : null,
      ...(identities ? { identities: { from: identity(identities.from), to: identity(identities.to) } } : {}),
    };
  } catch {
    return { laneId: null, packetId: null };
  }
}
