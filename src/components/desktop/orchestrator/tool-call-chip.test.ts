/**
 * Brain-chip classification for worker `o8 ask` shell commands (2026-06-11).
 * Workers reach the Engineering Brain via the CLI, so their transcript shows
 * a shell exec — the chip layer must render it as the same "Brain" chip the
 * orchestrator's cortex_ask MCP calls get.
 */

import { describe, expect, it } from 'vitest';

import { classifyToolCall, extractO8AskQuestion } from '@/components/desktop/orchestrator/ToolCallChip';

describe('extractO8AskQuestion', () => {
  it('extracts a double-quoted question', () => {
    expect(extractO8AskQuestion('o8 ask "What is the file ceiling?"')).toBe('What is the file ceiling?');
  });

  it('extracts a single-quoted question', () => {
    expect(extractO8AskQuestion("o8 ask 'Who owns the review surface?'")).toBe('Who owns the review surface?');
  });

  it('extracts an unquoted question up to the first flag', () => {
    expect(extractO8AskQuestion('o8 ask what is the ceiling --repo /tmp/x')).toBe('what is the ceiling');
  });

  it('handles a piped/chained command prefix', () => {
    expect(extractO8AskQuestion('cd /tmp && o8 ask "theming rule?"')).toBe('theming rule?');
  });

  it('returns null for non-ask o8 commands and other shells', () => {
    expect(extractO8AskQuestion('o8 packet info')).toBeNull();
    expect(extractO8AskQuestion('npm run lint')).toBeNull();
    expect(extractO8AskQuestion('echo "o8ask"')).toBeNull();
  });
});

describe('classifyToolCall with shell command', () => {
  it('classifies o8 ask execs as Brain', () => {
    expect(classifyToolCall('exec', 'o8 ask "What is the ceiling?"')).toEqual({ verb: 'Brain', kind: 'read' });
    expect(classifyToolCall('shell', 'o8 ask conventions for theming')).toEqual({ verb: 'Brain', kind: 'read' });
  });

  it('keeps plain shell commands as Run', () => {
    expect(classifyToolCall('exec', 'npm test')).toEqual({ verb: 'Run', kind: 'shell' });
    expect(classifyToolCall('bash')).toEqual({ verb: 'Run', kind: 'shell' });
  });

  it('still classifies cortex_ask MCP names as Brain', () => {
    expect(classifyToolCall('mcp__o8__cortex_ask')).toEqual({ verb: 'Brain', kind: 'read' });
  });
});
