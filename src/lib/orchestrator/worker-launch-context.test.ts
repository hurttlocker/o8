import { describe, expect, it } from 'vitest';
import {
  normalizeWorkerLaunchContext,
  shouldOpenWorkerInDedicatedPane,
  workerLaunchOriginLabel,
} from './worker-launch-context';

describe('worker launch context', () => {
  it('normalizes bounded outside provenance and requests a dedicated pane', () => {
    const context = normalizeWorkerLaunchContext({
      source: 'cli',
      presentation: 'split',
      repoContext: 'transient',
      caller: ' outside terminal ',
    });
    expect(context).toEqual({
      source: 'cli',
      presentation: 'split',
      repoContext: 'transient',
      caller: 'outside terminal',
    });
    expect(shouldOpenWorkerInDedicatedPane(context)).toBe(true);
    expect(workerLaunchOriginLabel(context)).toBe('outside terminal via o8 CLI');
  });

  it('keeps desktop launches in their existing tab presentation', () => {
    const context = normalizeWorkerLaunchContext({
      source: 'desktop',
      presentation: 'split',
      repoContext: 'registered',
    });
    expect(shouldOpenWorkerInDedicatedPane(context)).toBe(false);
  });

  it('rejects partial or unknown launch records', () => {
    expect(normalizeWorkerLaunchContext({ source: 'cli', presentation: 'split' })).toBeUndefined();
    expect(normalizeWorkerLaunchContext({ source: 'shell', presentation: 'split', repoContext: 'transient' })).toBeUndefined();
  });
});
