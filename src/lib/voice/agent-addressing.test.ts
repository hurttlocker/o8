import { describe, expect, it } from 'vitest';
import { resolveAgentReference, type AddressableFleetAgent } from './agent-addressing';

const agents: AddressableFleetAgent[] = [
  {
    id: 'agent-auth',
    laneId: 'lane-auth',
    packetId: 'pkt-auth',
    name: 'Auth refresh',
    runtime: 'codex',
    sessionKey: 'codex-owned:secret-internal-key',
    packetTitle: 'Repair authentication refresh',
    currentTask: 'Updating the OAuth callback',
    workspace: '/repo',
    branch: 'issue/auth-refresh',
  },
  {
    id: 'agent-mobile',
    laneId: 'lane-mobile',
    packetId: 'pkt-mobile',
    name: 'Mobile inbox',
    runtime: 'claude-code',
    packetTitle: 'Bring mobile packet review current',
    currentTask: 'Updating the mobile review queue',
    workspace: '/repo',
    branch: 'issue/mobile-inbox',
  },
];

describe('agent addressing', () => {
  it('resolves a human packet reference without exposing session keys', () => {
    const result = resolveAgentReference('the mobile packet', agents);

    expect(result.match).toMatchObject({
      agentId: 'agent-mobile',
      laneId: 'lane-mobile',
      packetId: 'pkt-mobile',
      label: 'Mobile inbox',
    });
    expect(result.disambiguationPrompt).toBeNull();
    expect(JSON.stringify(result)).not.toContain('secret-internal-key');
  });

  it('returns candidates and a prompt when a reference is ambiguous', () => {
    const result = resolveAgentReference('the auth one', [
      agents[0],
      {
        ...agents[0],
        id: 'agent-auth-tests',
        laneId: 'lane-auth-tests',
        packetId: 'pkt-auth-tests',
        name: 'Auth tests',
        packetTitle: 'Repair authentication tests',
      },
    ]);

    expect(result.match).toBeNull();
    expect(result.candidates).toHaveLength(2);
    expect(result.disambiguationPrompt).toContain('Auth refresh or Auth tests');
  });
});

