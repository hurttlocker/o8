import { describe, expect, it } from 'vitest';

import { renderHumanSemanticSurface } from '../../presentation/text';
import { buildPacketInfoSurface } from './info-surface';

const fixture = {
  laneId: 'lane-1',
  packetId: 'packet-1',
  status: 'running',
  runtime: 'pi',
  actualRuntime: 'pi',
  branch: 'feat/x',
  baseBranch: 'main',
  repoPath: '/repo',
  worktreePath: '/repo/.cortex-worktrees/packet-1',
  label: 'Fix thing',
  events: [
    {
      id: 'event-1',
      timestamp: '2026-10-07T15:00:00.000Z',
      actor: 'agent',
      verb: 'started',
    },
  ],
} as const;

describe('packet info semantic surface', () => {
  it('keeps stable semantic ids and packet facts', () => {
    const surface = buildPacketInfoSurface(fixture);

    expect(surface.id).toBe('packet-info:lane-1');
    expect(surface.blocks[0]).toEqual({
      kind: 'facts',
      id: 'packet',
      title: 'packet',
      facts: [
        { id: 'lane', label: 'lane', value: 'lane-1' },
        { id: 'packet', label: 'packet', value: 'packet-1' },
        { id: 'status', label: 'status', value: 'running' },
        { id: 'runtime', label: 'runtime', value: 'pi' },
        { id: 'actual-runtime', label: 'actual runtime', value: 'pi' },
        { id: 'branch', label: 'branch', value: 'feat/x' },
        { id: 'base', label: 'base', value: 'main' },
        { id: 'repo', label: 'repo', value: '/repo' },
        { id: 'worktree', label: 'worktree', value: '/repo/.cortex-worktrees/packet-1' },
        { id: 'label', label: 'label', value: 'Fix thing' },
      ],
    });
    expect(surface.blocks[1]).toEqual({
      kind: 'event-log',
      id: 'recent-events',
      title: 'recent events (1)',
      events: fixture.events,
    });
  });

  it('preserves the existing human packet-info text shape', () => {
    const chunks: string[] = [];
    renderHumanSemanticSurface(buildPacketInfoSurface(fixture), (text) => chunks.push(text));

    const expected = [
      '',
      'packet',
      `${'lane'.padEnd(14)}  lane-1`,
      `${'packet'.padEnd(14)}  packet-1`,
      `${'status'.padEnd(14)}  running`,
      `${'runtime'.padEnd(14)}  pi`,
      `${'actual runtime'.padEnd(14)}  pi`,
      `${'branch'.padEnd(14)}  feat/x`,
      `${'base'.padEnd(14)}  main`,
      `${'repo'.padEnd(14)}  /repo`,
      `${'worktree'.padEnd(14)}  /repo/.cortex-worktrees/packet-1`,
      `${'label'.padEnd(14)}  Fix thing`,
      '',
      'recent events (1)',
      `  2026-10-07T15:00:00.000Z  ${'agent'.padEnd(13)} started`,
      '',
    ].join('\n');

    expect(chunks.join('')).toBe(expected);
  });

  it('does not invent a recent-events block when there are no events', () => {
    const surface = buildPacketInfoSurface({ ...fixture, events: [] });
    expect(surface.blocks).toHaveLength(1);
  });
});
