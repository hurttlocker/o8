import { describe, expect, it } from 'vitest';

import { computeNewTerminalTab } from './terminal-tab-handlers';

describe('workspace terminal CLI launch', () => {
  it('opens Magnitude in the selected repository with an install fallback', () => {
    const result = computeNewTerminalTab('magnitude', {
      name: 'demo',
      localPath: '/tmp/demo repo',
      branch: 'main',
    });

    expect(result.newTab).toMatchObject({
      label: 'Magnitude',
      kind: 'terminal',
      cliAgent: 'magnitude',
      repo: { localPath: '/tmp/demo repo' },
    });
    expect(result.cliCommand).toContain("cd '/tmp/demo repo'");
    expect(result.cliCommand).toContain('command -v magnitude');
    expect(result.cliCommand).toContain('npm i -g @magnitudedev/cli');
  });
});
