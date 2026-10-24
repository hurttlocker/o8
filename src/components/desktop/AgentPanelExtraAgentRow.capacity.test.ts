import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ExtraAgentRowView, type ExtraAgentRow } from './AgentPanelExtraAgentRow';
import { deriveSpawnedAgentState } from './spawned-agents-hover-card-utils';

const resetsAt = '2026-10-25T12:30:00.000Z';
const label = `waiting_for_limit_reset:${resetsAt}`;
const row: ExtraAgentRow = {
  key: 'lane:capacity-fixture', origin: 'CLI', status: 'waiting', runtime: 'codex', model: null,
  name: 'Fixture task', subtitle: '', lastActivityAt: 0, sessionKey: 'codex-owned:fixture',
  repoPath: '/repos/fixture', packetId: null, laneId: 'capacity-fixture', laneStatus: 'paused',
  outcome: null, outcomeNote: null, lastEventLabel: label,
};

describe('capacity wait in the agent sidebar', () => {
  it('renders the reset state and time instead of idle or running', () => {
    const markup = renderToStaticMarkup(createElement(ExtraAgentRowView, { row, active: false, busy: false, band: 'neutral' }));
    expect(markup).toContain('Waiting for limit reset');
    expect(markup).toContain(resetsAt);
  });
  it('uses the same waiting state in the hover card', () => {
    expect(deriveSpawnedAgentState('paused', 'waiting', label).label).toBe(`Waiting for limit reset at ${resetsAt}`);
  });
});
