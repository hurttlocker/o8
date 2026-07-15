import { beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

  it('matches terminal cwd aliases by their canonical in-repo directory', () => {
    const repo = mkdtempSync(join(tmpdir(), 'o8-grant-repo-'));
    mkdirSync(join(repo, 'packages', 'app'), { recursive: true });
    symlinkSync(join(repo, 'packages', 'app'), join(repo, 'app-link'));
    const token = issueLlmToolGrant({
      tabId: 'tab-1',
      repoPath: repo,
      toolName: 'run_terminal_command',
      args: { command: 'pwd', cwd: 'app-link' },
    });

    expect(consumeLlmToolGrant({
      token,
      tabId: 'tab-1',
      repoPath: repo,
      toolName: 'run_terminal_command',
      args: { command: 'pwd', cwd: 'packages/app' },
    })).toBe(true);
  });

  it('burns a terminal grant when a cwd symlink is retargeted after approval', () => {
    const repo = mkdtempSync(join(tmpdir(), 'o8-grant-repo-'));
    mkdirSync(join(repo, 'packages', 'first'), { recursive: true });
    mkdirSync(join(repo, 'packages', 'second'), { recursive: true });
    const alias = join(repo, 'app-link');
    symlinkSync(join(repo, 'packages', 'first'), alias);
    const token = issueLlmToolGrant({
      tabId: 'tab-1',
      repoPath: repo,
      toolName: 'run_terminal_command',
      args: { command: 'pwd', cwd: 'app-link' },
    });
    rmSync(alias);
    symlinkSync(join(repo, 'packages', 'second'), alias);

    expect(consumeLlmToolGrant({
      token,
      tabId: 'tab-1',
      repoPath: repo,
      toolName: 'run_terminal_command',
      args: { command: 'pwd', cwd: 'app-link' },
    })).toBe(false);
  });
});
