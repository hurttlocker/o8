import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PROJECTS_UPDATED_EVENT,
  refreshProjectsFromExternalMutation,
} from './useProjects';

describe('refreshProjectsFromExternalMutation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('refreshes both project and repo browser state', () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal('window', { dispatchEvent });

    refreshProjectsFromExternalMutation();

    expect(dispatchEvent.mock.calls.map(([event]) => event.type)).toEqual([
      PROJECTS_UPDATED_EVENT,
      'o8:repos-changed',
    ]);
  });
});
