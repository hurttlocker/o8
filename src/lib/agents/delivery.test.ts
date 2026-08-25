import { describe, expect, it } from 'vitest';

import { buildClaudeTerminalUserTurn, submitClaudeTerminalUserTurn } from './delivery';

describe('buildClaudeTerminalUserTurn', () => {
  it('keeps arbitrary message text inside one shell-quoted argument', () => {
    expect(buildClaudeTerminalUserTurn("don't\n; touch /tmp/should-not-run")).toBe(
      "o8-agent-message 'don'\"'\"'t\n; touch /tmp/should-not-run'",
    );
  });

  it('targets the exact terminal and submits after pasting the message', async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    await submitClaudeTerminalUserTurn({
      tty: '/dev/ttys004',
      pid: 4312,
      content: 'Ping.',
    }, async (file, args) => {
      calls.push({ file, args });
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      file: 'osascript',
      args: [
        '-e',
        expect.stringContaining('do script "" in terminalTab'),
        '/dev/ttys004',
        "o8-agent-message 'Ping.'",
        '4312',
      ],
    });
  });
});
