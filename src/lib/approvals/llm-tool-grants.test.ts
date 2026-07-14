import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearLlmToolGrantsForTests,
  consumeLlmToolGrant,
  issueLlmToolGrant,
  toolArgsEqual,
} from './llm-tool-grants';

describe('LLM tool approval grants', () => {
  beforeEach(() => clearLlmToolGrantsForTests());

  it('matches equivalent arguments regardless of object key order', () => {
    expect(toolArgsEqual({ path: 'a', options: { b: 2, a: 1 } }, { options: { a: 1, b: 2 }, path: 'a' })).toBe(true);
  });

  it('is scoped to one exact tool call and consumed once', () => {
    const token = issueLlmToolGrant({
      tabId: 'tab-1',
      repoPath: '/repo',
      toolName: 'run_terminal_command',
      args: { command: 'git status' },
    });

    const exactCall = {
      token,
      tabId: 'tab-1',
      repoPath: '/repo',
      toolName: 'run_terminal_command',
      args: { command: 'git status' },
    };
    expect(consumeLlmToolGrant(exactCall)).toBe(true);
    expect(consumeLlmToolGrant(exactCall)).toBe(false);
  });

  it('burns a grant when the same tool changes its arguments', () => {
    const token = issueLlmToolGrant({
      tabId: 'tab-1',
      repoPath: '/repo',
      toolName: 'run_terminal_command',
      args: { command: 'git status' },
    });

    expect(consumeLlmToolGrant({
      token,
      tabId: 'tab-1',
      repoPath: '/repo',
      toolName: 'run_terminal_command',
      args: { command: 'cat ~/.o8/ws-token' },
    })).toBe(false);
    expect(consumeLlmToolGrant({
      token,
      tabId: 'tab-1',
      repoPath: '/repo',
      toolName: 'run_terminal_command',
      args: { command: 'git status' },
    })).toBe(false);
  });
});
