import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CliError, EXIT } from '../api';
import { codename } from '../../../src/lib/agents/codename';
import { resolveAgentIdentity, runTeam } from './team';

const roots: string[] = [];
const jsonMode = { human: false, verbose: false };

function createRepo(): string {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'o8-team-presence-'));
  roots.push(repo);
  execFileSync('git', ['init', '--quiet', repo]);
  return repo;
}

function presenceDir(repo: string): string {
  return path.join(repo, '.git', 'agents', 'presence');
}

function presenceFile(repo: string, identity: string): string {
  return path.join(presenceDir(repo), `${encodeURIComponent(identity)}.json`);
}

function options(repo: string, identity: string) {
  return { cwd: repo, env: { O8_AGENT_ID: identity }, ppid: 300 };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('team CLI session identity', () => {
  it('prefers explicit and packet bindings, ignores terminal ids, and walks stable ancestry', () => {
    expect(resolveAgentIdentity({
      env: {
        O8_AGENT_ID: 'explicit-session',
        O8_WORKER_PACKET_ID: 'packet-session',
        CLAUDE_CODE_SESSION_ID: 'claude-session',
      },
    })).toBe('explicit-session');
    expect(resolveAgentIdentity({
      env: {
        O8_WORKER_PACKET_ID: 'packet-session',
        CLAUDE_CODE_SESSION_ID: 'claude-session',
      },
    })).toBe('packet-session');
    expect(resolveAgentIdentity({
      env: { CLAUDE_CODE_SESSION_ID: 'claude-session' },
    })).toBe('claude-session');

    const rows = new Map([
      [300, { pid: 300, ppid: 200, command: '/bin/sh -lc o8 team status working' }],
      [200, { pid: 200, ppid: 100, command: '/usr/local/bin/agent-runtime' }],
    ]);
    expect(resolveAgentIdentity({
      env: { TERM_SESSION_ID: 'shared-terminal' },
      ppid: 300,
      readProcess: (pid) => rows.get(pid) ?? null,
    })).toBe('pid-200');
  });

  it('keeps the first agent byte-unchanged when a second agent writes status in the same checkout', () => {
    const repo = createRepo();
    const stdout: string[] = [];
    const stderr: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);

    expect(runTeam(jsonMode, 'who', [], options(repo, 'session-one'))).toBe(EXIT.OK);
    expect(runTeam(jsonMode, 'who', [], options(repo, 'session-two'))).toBe(EXIT.OK);
    const firstBefore = readFileSync(presenceFile(repo, 'session-one'), 'utf8');

    expect(runTeam(jsonMode, 'status', ['reviewing', 'identity'], options(repo, 'session-two'))).toBe(EXIT.OK);

    expect(readFileSync(presenceFile(repo, 'session-one'), 'utf8')).toBe(firstBefore);
    const second = JSON.parse(readFileSync(presenceFile(repo, 'session-two'), 'utf8')) as {
      handle: string;
      sessionKey: string;
      status: string;
    };
    expect(second).toMatchObject({
      handle: codename('session-two'),
      sessionKey: 'session-two',
      status: 'reviewing identity',
    });
    expect(stderr.join('')).toContain(`as @${codename('session-two')} · session-two`);
    expect(JSON.parse(stdout.at(-1) ?? '{}')).toMatchObject({
      handle: codename('session-two'),
      sessionKey: 'session-two',
    });
  });

  it('refuses a status write owned by another session and leaves the file unchanged', () => {
    const repo = createRepo();
    const file = presenceFile(repo, 'resolved-session');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({
      agentId: 'resolved-session',
      sessionKey: 'owner-session',
      handle: 'Owner',
      runtime: 'cli',
      pid: 200,
      cwd: repo,
      status: 'owner work',
      startedAt: '2026-08-28T10:00:00.000Z',
      lastSeen: '2026-08-28T10:00:00.000Z',
    }, null, 2));
    const before = readFileSync(file, 'utf8');

    let caught: unknown;
    try {
      runTeam(jsonMode, 'status', ['intruding'], options(repo, 'resolved-session'));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CliError);
    expect(caught).toMatchObject({
      code: 'foreign_identity',
      exit: EXIT.CONFLICT,
      message: 'This status line is owned by @Owner (owner-session); your session is resolved-session.',
    });
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('fails closed without a stable identity and writes no presence file', () => {
    const repo = createRepo();
    let caught: unknown;
    try {
      runTeam(jsonMode, 'status', ['unresolved'], { cwd: repo, env: {}, ppid: 1 });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CliError);
    expect(caught).toMatchObject({ code: 'identity_unresolved', exit: EXIT.CONFLICT });
    expect((caught as Error).message).toContain('Set O8_AGENT_ID');
    expect(readdirSync(presenceDir(repo))).toEqual([]);
  });

  it('adopts a matching legacy file and stamps its session key once', () => {
    const repo = createRepo();
    const identity = 'legacy-session';
    const file = presenceFile(repo, identity);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({
      agentId: identity,
      handle: 'Legacy',
      runtime: 'cli',
      pid: 200,
      cwd: repo,
      status: 'legacy work',
      startedAt: '2026-08-28T10:00:00.000Z',
      lastSeen: new Date().toISOString(),
    }, null, 2));
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(runTeam(jsonMode, 'status', ['adopted'], options(repo, identity))).toBe(EXIT.OK);
    const adopted = readFileSync(file, 'utf8');
    expect(JSON.parse(adopted)).toMatchObject({
      agentId: identity,
      sessionKey: identity,
      handle: 'Legacy',
      status: 'adopted',
      startedAt: '2026-08-28T10:00:00.000Z',
    });
    expect(adopted.match(/"sessionKey"/g)).toHaveLength(1);

    expect(runTeam(jsonMode, 'status', ['still', 'owned'], options(repo, identity))).toBe(EXIT.OK);
    const touchedAgain = readFileSync(file, 'utf8');
    expect(JSON.parse(touchedAgain)).toMatchObject({ sessionKey: identity, status: 'still owned' });
    expect(touchedAgain.match(/"sessionKey"/g)).toHaveLength(1);
  });
});
