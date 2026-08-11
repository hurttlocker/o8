import { describe, expect, it } from 'vitest';

import { directiveAppliesToRepo, type DirectiveProjectScope } from './filter';
import type { ParsedDirective } from './parse';

const inactiveProject: DirectiveProjectScope = {
  projectIds: new Set(),
  projectSlugs: new Set(),
  repoInActiveProject: false,
};

function directive(overrides: Partial<ParsedDirective>): ParsedDirective {
  return {
    id: 'test-directive',
    title: 'Test directive',
    scope: 'global',
    repoName: null,
    projects: [],
    projectIds: [],
    priority: null,
    body: 'body',
    ...overrides,
  };
}

describe('directiveAppliesToRepo', () => {
  it('keeps repo directives available when the repo is outside the active project', () => {
    expect(directiveAppliesToRepo(
      directive({ scope: 'repo', repoName: 'o8' }),
      '/repos/o8',
      inactiveProject,
    )).toBe(true);
  });

  it('still excludes project directives when the repo is outside the active project', () => {
    expect(directiveAppliesToRepo(
      directive({ scope: 'project', projects: ['workspace'] }),
      '/repos/o8',
      inactiveProject,
    )).toBe(false);
  });
});
