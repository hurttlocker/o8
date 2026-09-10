import { describe, expect, it } from 'vitest';

import { computeNewTerminalTab, detectLocalhostPreviews } from './terminal-tab-handlers';

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

describe('terminal preview decoding through the output handler', () => {
  it('preserves ANSI stripping, Unicode paths and duplicate-port suppression', () => {
    const ports = new Set<number>();
    const data = Buffer.from('\x1b[32mReady: http://0.0.0.0:5173/café\x1b[0m\r\n').toString('base64');
    expect(detectLocalhostPreviews(data, 'session', [], ports)).toEqual([
      expect.objectContaining({ url: 'http://localhost:5173/café', port: 5173 }),
    ]);
    expect(detectLocalhostPreviews(data, 'session', [], ports)).toEqual([]);
  });

  it('ignores malformed output without disrupting the terminal caller', () => {
    expect(detectLocalhostPreviews('invalid!', 'session', [], new Set())).toEqual([]);
  });
});
