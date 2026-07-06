import { describe, expect, it } from 'vitest';
import type { ActivityItem } from './agent-panel/types';
import { groupActivityByCommitSha } from './o8-activity-grouping';

function commit(hash: string, ts: number): ActivityItem {
  return { kind: 'commit', hash, message: `commit ${hash.slice(0, 7)}`, age: '1m', ts, repo: 'hurttlocker/o8' };
}

function ci(id: number, headSha: string, conclusion: string, ts: number): ActivityItem {
  return {
    kind: 'ci',
    id,
    title: 'checks',
    status: 'completed',
    conclusion,
    branch: 'main',
    workflow: 'CI',
    age: '1m',
    ts,
    repo: 'hurttlocker/o8',
    headSha,
  };
}

function push(id: string, sha: string, ts: number): ActivityItem {
  return {
    kind: 'event',
    ts,
    data: {
      id,
      agentId: 'agent',
      squadId: 'squad',
      severity: 'info',
      title: `pushed ${sha.slice(0, 7)}`,
      detail: `git push ${sha}`,
      timestamp: new Date(ts).toISOString(),
    },
  };
}

describe('groupActivityByCommitSha', () => {
  it('collapses commit, push, and CI events for the same SHA into one row', () => {
    const sha = 'abc1234abc1234abc1234abc1234abc1234abc';
    const grouped = groupActivityByCommitSha([commit(sha, 100), push('push-1', sha, 300), ci(1, sha, 'success', 200)]);

    expect(grouped).toHaveLength(1);
    expect(grouped[0]?.kind).toBe('commit');
    if (grouped[0]?.kind !== 'commit') throw new Error('expected commit');
    expect(grouped[0].ts).toBe(300);
    expect(grouped[0].groupedPushEvent?.id).toBe('push-1');
    expect(grouped[0].groupedCiRun?.id).toBe(1);
  });

  it('keeps interleaved SHAs ordered by newest event in each group', () => {
    const a = 'aaaaaaa111111111111111111111111111111111';
    const b = 'bbbbbbb222222222222222222222222222222222';
    const grouped = groupActivityByCommitSha([commit(a, 100), commit(b, 400), ci(2, a, 'failure', 500)]);

    expect(grouped).toHaveLength(2);
    expect(grouped[0]?.kind === 'commit' ? grouped[0].hash : '').toBe(a);
    expect(grouped[1]?.kind === 'commit' ? grouped[1].hash : '').toBe(b);
  });

  it('passes SHA-less events through ungrouped', () => {
    const sha = 'ccccccc333333333333333333333333333333333';
    const event: ActivityItem = {
      kind: 'event',
      ts: 200,
      data: {
        id: 'evt-1',
        agentId: 'agent',
        squadId: 'squad',
        severity: 'info',
        title: 'packet reviewed',
        detail: 'no commit attached',
        timestamp: new Date(200).toISOString(),
      },
    };
    const grouped = groupActivityByCommitSha([commit(sha, 100), event]);

    expect(grouped).toHaveLength(2);
    expect(grouped[0]).toBe(event);
  });
});
