import { describe, expect, it } from 'vitest';

import {
  findWaitingOutsiders,
  type OutsiderAttentionThread,
} from './outsider-attention';

const NOW = new Date('2026-08-27T16:00:00.000Z');
const DAY_MS = 24 * 60 * 60_000;

function thread(overrides: Partial<OutsiderAttentionThread> = {}): OutsiderAttentionThread {
  return {
    repo: 'example/repo',
    kind: 'issue',
    number: 1881,
    url: 'https://github.com/example/repo/issues/1881',
    title: 'Answer the contributor',
    state: 'open',
    closedAt: null,
    lastHumanCommentAuthorLogin: 'outside-contributor',
    lastHumanCommentAuthorAssociation: 'CONTRIBUTOR',
    lastHumanCommentAt: '2026-08-26T15:00:00.000Z',
    lastInsiderCommentAt: null,
    ...overrides,
  };
}

describe('findWaitingOutsiders', () => {
  it('returns an outsider followed by silence', () => {
    expect(findWaitingOutsiders([thread()], NOW, DAY_MS)).toEqual([{
      repo: 'example/repo',
      kind: 'issue',
      number: 1881,
      url: 'https://github.com/example/repo/issues/1881',
      title: 'Answer the contributor',
      waitingLogin: 'outside-contributor',
      waitingSince: '2026-08-26T15:00:00.000Z',
      hours: 25,
    }]);
  });

  it('clears an outsider after a newer insider reply', () => {
    expect(findWaitingOutsiders([thread({
      lastInsiderCommentAt: '2026-08-26T15:05:00.000Z',
    })], NOW, DAY_MS)).toEqual([]);
  });

  it('ignores bot-only activity', () => {
    expect(findWaitingOutsiders([thread({
      lastHumanCommentAuthorLogin: 'automation[bot]',
      lastHumanCommentAuthorAssociation: 'NONE',
    })], NOW, DAY_MS)).toEqual([]);
  });

  it('includes the exact threshold boundary and excludes one millisecond before it', () => {
    const boundary = '2026-08-26T16:00:00.000Z';
    expect(findWaitingOutsiders([thread({ lastHumanCommentAt: boundary })], NOW, DAY_MS)).toHaveLength(1);
    expect(findWaitingOutsiders([thread({
      lastHumanCommentAt: '2026-08-26T16:00:00.001Z',
    })], NOW, DAY_MS)).toEqual([]);
  });

  it('ignores threads closed more than seven days ago', () => {
    expect(findWaitingOutsiders([thread({
      state: 'closed',
      closedAt: '2026-08-20T15:59:59.999Z',
    })], NOW, DAY_MS)).toEqual([]);
  });
});
