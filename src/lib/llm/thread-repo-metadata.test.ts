import { describe, expect, it } from 'vitest';
import { resolveThreadRepoMetadata } from '@/lib/llm/thread-repo-metadata';

describe('resolveThreadRepoMetadata', () => {
  it('keeps existing thoughts thread repo scope when a later post sends another repo', () => {
    expect(resolveThreadRepoMetadata({
      tabId: 'thoughts-123',
      existingRepoPath: '/Users/example/o8',
      existingRepoName: 'o8',
      existingRepoBranch: 'main',
      bodyRepoPath: '/Users/example/o8-mobile',
      bodyRepoName: 'o8-mobile',
      bodyRepoBranch: 'feature/mobile',
    })).toEqual({
      repoPath: '/Users/example/o8',
      repoName: 'o8',
      repoBranch: 'main',
    });
  });

  it('allows a new thoughts thread to take the posted repo scope', () => {
    expect(resolveThreadRepoMetadata({
      tabId: 'thoughts-456',
      bodyRepoPath: '/Users/example/o8',
      bodyRepoName: 'o8',
      bodyRepoBranch: 'main',
    })).toEqual({
      repoPath: '/Users/example/o8',
      repoName: 'o8',
      repoBranch: 'main',
    });
  });

  it('preserves non-orchestrator chat behavior', () => {
    expect(resolveThreadRepoMetadata({
      tabId: 'mobile-chat-1',
      existingRepoPath: '/Users/example/o8',
      existingRepoName: 'o8',
      bodyRepoPath: '/Users/example/o8-mobile',
      bodyRepoName: 'o8-mobile',
    })).toEqual({
      repoPath: '/Users/example/o8-mobile',
      repoName: 'o8-mobile',
      repoBranch: undefined,
    });
  });
});
