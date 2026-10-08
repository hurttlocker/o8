import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acquireReleaseLock,
  performShipPreflight,
  runQuickBenchmarkPreflight,
} from '../scripts/lib/ship-preflight.mjs';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'o8-ship-preflight-'));
  roots.push(root);
  const home = join(root, 'home');
  mkdirSync(join(home, '.tauri'), { recursive: true });
  writeFileSync(join(home, '.tauri', 'cortex-ide.key'), 'test-key');
  const head = 'a'.repeat(40);
  writeFileSync(join(root, 'o8.release.json'), JSON.stringify({
    clerkPublishableKey: 'pk_test_synthetic',
    githubOAuthClientId: 'synthetic-client-id',
    sentryDsn: 'https://synthetic@example.invalid/1',
  }));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    APPLE_SIGNING_IDENTITY: 'Developer ID test',
    APPLE_ID: 'test@example.invalid',
    APPLE_PASSWORD: 'not-a-real-secret',
    APPLE_TEAM_ID: 'TEAMTEST',
    O8_RELEASE_MIN_FREE_GIB: '0.001',
  };
  delete env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  delete env.GITHUB_OAUTH_CLIENT_ID;
  delete env.SENTRY_DSN;
  return { root, home, head, env };
}

function passingRun(head: string) {
  return (command: string, args: string[]) => {
    if (command === 'git' && (args[0] === 'rev-parse' || args[0] === 'rev-list')) return { status: 0, stdout: `${head}\n`, stderr: '' };
    if (command === 'git' && args[0] === 'status') return { status: 0, stdout: '', stderr: '' };
    if (command === 'git' && args[0] === 'remote') return { status: 0, stdout: 'git@github.com:example/release-repo.git\n', stderr: '' };
    if (command === 'git' && args[0] === 'ls-remote') return { status: 0, stdout: `${head}\trefs/tags/v0.1.999^{}\n`, stderr: '' };
    if (command === 'gh' && args[0] === 'api') return args[1]?.includes('/releases/tags/')
      ? { status: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' }
      : { status: 0, stdout: JSON.stringify(args[1]?.includes('/releases?') ? [] : { full_name: 'example/release-repo' }), stderr: '' };
    if (command === 'ps') return { status: 0, stdout: `${process.pid} 1 node scripts/ship-preflight.mjs\n`, stderr: '' };
    return { status: 0, stdout: `${command} test-version\n`, stderr: '' };
  };
}

describe('ship preflight', () => {
  it('refuses to build when the desktop release configuration is missing', () => {
    const { root, head, env } = fixture();
    rmSync(join(root, 'o8.release.json'));
    let message = '';
    try { performShipPreflight({ root, version: '0.1.999', env, run: passingRun(head) }); } catch (error) { message = (error as Error).message; }
    expect(message).toContain('missing desktop release configuration: clerkPublishableKey, githubOAuthClientId, sentryDsn');
  });

  it('accepts the desktop release configuration from the environment and never reports its values', () => {
    const { root, head, env } = fixture();
    rmSync(join(root, 'o8.release.json'));
    env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test_from_env';
    env.GITHUB_OAUTH_CLIENT_ID = 'client-from-env';
    env.SENTRY_DSN = 'https://env@example.invalid/2';
    const receipt = performShipPreflight({ root, version: '0.1.999', env, run: passingRun(head) });
    expect(receipt.releaseConfigKeys).toEqual(['clerkPublishableKey', 'githubOAuthClientId', 'sentryDsn']);
    expect(JSON.stringify(receipt)).not.toMatch(/pk_test_from_env|client-from-env|env@example/);
  });

  it('proves tag, remote, credentials, disk, tools, and a clear build owner before work starts', () => {
    const { root, head, env } = fixture();
    const calls: string[] = [];
    const run = (command: string, args: string[]) => {
      calls.push(`${command} ${args.join(' ')}`);
      if (command === 'git' && args[0] === 'rev-parse') return { status: 0, stdout: `${head}\n`, stderr: '' };
      if (command === 'git' && args[0] === 'rev-list') return { status: 0, stdout: `${head}\n`, stderr: '' };
      if (command === 'git' && args[0] === 'status') return { status: 0, stdout: ' M o8.md\n', stderr: '' };
      if (command === 'git' && args[0] === 'remote') {
        return { status: 0, stdout: 'git@github.com:example/release-repo.git\n', stderr: '' };
      }
      if (command === 'git' && args[0] === 'ls-remote') {
        return { status: 0, stdout: `${head}\trefs/tags/v0.1.999^{}\n`, stderr: '' };
      }
      if (command === 'gh' && args[0] === 'api') return args[1]?.includes('/releases/tags/')
        ? { status: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' }
        : { status: 0, stdout: JSON.stringify(args[1]?.includes('/releases?') ? [] : { full_name: 'example/release-repo' }), stderr: '' };
      if (command === 'ps') {
        return {
          status: 0,
          stdout: `${process.pid} 1 node scripts/ship-preflight.mjs\n${process.ppid} 1 node scripts/release.mjs --ship\n`,
          stderr: '',
        };
      }
      return { status: 0, stdout: `${command} test-version\n`, stderr: '' };
    };

    const receipt = performShipPreflight({ root, version: '0.1.999', env, run });

    expect(receipt.head).toBe(head);
    expect(receipt.remoteTagHead).toBe(head);
    expect(receipt.releaseAbsent).toBe(true);
    expect(receipt.credentialNames).not.toContain('not-a-real-secret');
    expect(receipt.intakeReconciliation).toMatchObject({ status: 'missing' });
    expect(calls).toContain('gh api repos/example/release-repo');
    expect(calls).toContain('gh api repos/example/release-repo/releases?per_page=1');
    expect(calls).toContain('gh api repos/example/release-repo/releases/tags/v0.1.999');
    expect(calls.at(-1)).toBe('ps -axo pid=,ppid=,command=');
  });

  it('refuses a mismatched remote tag before any release lookup', () => {
    const { root, head, env } = fixture();
    let releaseLookup = false;
    const run = (command: string, args: string[]) => {
      if (command === 'git' && args[0] === 'rev-parse') return { status: 0, stdout: head, stderr: '' };
      if (command === 'git' && args[0] === 'rev-list') return { status: 0, stdout: head, stderr: '' };
      if (command === 'git' && args[0] === 'status') return { status: 0, stdout: '', stderr: '' };
      if (command === 'git' && args[0] === 'remote') {
        return { status: 0, stdout: 'https://github.com/example/release-repo.git\n', stderr: '' };
      }
      if (command === 'git' && args[0] === 'ls-remote') {
        return { status: 0, stdout: `${'b'.repeat(40)}\trefs/tags/v0.1.999\n`, stderr: '' };
      }
      if (command === 'gh') releaseLookup = true;
      return { status: 0, stdout: 'ok', stderr: '' };
    };

    expect(() => performShipPreflight({ root, version: '0.1.999', env, run }))
      .toThrow('remote tag');
    expect(releaseLookup).toBe(false);
  });

  it('holds one exclusive release-output owner and reclaims a released lock', () => {
    const { root } = fixture();
    const lockPath = join(root, 'ship.lock');
    const first = acquireReleaseLock({ lockPath });
    expect(() => acquireReleaseLock({ lockPath })).toThrow('live ship pid');
    first.release();
    const second = acquireReleaseLock({ lockPath });
    second.release();
  });

  it('refuses a real competing build without counting the current release parent', () => {
    const { root, head, env } = fixture();
    const run = (command: string, args: string[]) => {
      if (command === 'git' && args[0] === 'rev-parse') return { status: 0, stdout: head, stderr: '' };
      if (command === 'git' && args[0] === 'rev-list') return { status: 0, stdout: head, stderr: '' };
      if (command === 'git' && args[0] === 'status') return { status: 0, stdout: '', stderr: '' };
      if (command === 'git' && args[0] === 'remote') {
        return { status: 0, stdout: 'https://github.com/example/release-repo.git\n', stderr: '' };
      }
      if (command === 'git' && args[0] === 'ls-remote') {
        return { status: 0, stdout: `${head}\trefs/tags/v0.1.999^{}\n`, stderr: '' };
      }
      if (command === 'gh' && args[0] === 'api') return args[1]?.includes('/releases/tags/')
        ? { status: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' }
        : { status: 0, stdout: JSON.stringify(args[1]?.includes('/releases?') ? [] : { full_name: 'example/release-repo' }), stderr: '' };
      if (command === 'ps') {
        return {
          status: 0,
          stdout: `${process.ppid} 1 node scripts/release.mjs --ship\n99999 1 cargo tauri build\n`,
          stderr: '',
        };
      }
      return { status: 0, stdout: `${command} test-version\n`, stderr: '' };
    };

    expect(() => performShipPreflight({ root, version: '0.1.999', env, run }))
      .toThrow('another ship or build owns the release output');
  });

  it('surfaces a quick benchmark regression without turning it into a preflight failure', () => {
    const { root, env } = fixture();
    const run = () => ({
      status: 0,
      stdout: `noise\nO8_BENCH_QUICK_RECEIPT=${JSON.stringify({
        schema: 'o8/benchmark-quick-preflight/v1',
        status: 'regressed',
        regressions: [{ name: 'time_to_reveal_ms', deltaValue: 125 }],
        missing: [],
      })}\n`,
      stderr: '',
    });

    const receipt = runQuickBenchmarkPreflight({ root, env, run });

    expect(receipt.status).toBe('regressed');
    expect(receipt.regressions).toEqual([{ name: 'time_to_reveal_ms', deltaValue: 125 }]);
  });

  it('keeps ship preflight non-blocking when the quick benchmark cannot run', () => {
    const { root, env } = fixture();
    const receipt = runQuickBenchmarkPreflight({
      root,
      env,
      run: () => ({ status: 1, stdout: '', stderr: 'browser unavailable' }),
    });

    expect(receipt.status).toBe('unavailable');
    expect(receipt.message).toContain('browser unavailable');
  });

  it('aborts the ship when the test classification manifest is stale, with the same remedy CI prints', () => {
    const { root, head, env } = fixture();
    const remedy = '[test-classification] manifest drifted; run npm run test:classify';
    const calls: string[] = [];
    const run = (command: string, args: string[]) => {
      calls.push(`${command} ${args.join(' ')}`);
      if (command === 'git' && args[0] === 'rev-parse') return { status: 0, stdout: head, stderr: '' };
      if (command === 'git' && args[0] === 'rev-list') return { status: 0, stdout: head, stderr: '' };
      if (command === 'git' && args[0] === 'status') return { status: 0, stdout: '', stderr: '' };
      if (args[0] === 'scripts/classify-tests.mjs') return { status: 1, stdout: '', stderr: `${remedy}\n` };
      return { status: 0, stdout: `${command} test-version\n`, stderr: '' };
    };

    expect(() => performShipPreflight({ root, version: '0.1.999', env, run })).toThrow(remedy);
    expect(calls).toContain(`${process.execPath} scripts/classify-tests.mjs --check`);
    // No real build ran — the stub above never spawns node/npm/cargo for a build.
    expect(calls.some((call) => call.includes('build'))).toBe(false);
  });

  it('passes the ship preflight when the test classification manifest is current', () => {
    const { root, head, env } = fixture();
    const calls: string[] = [];
    const run = (command: string, args: string[]) => {
      calls.push(`${command} ${args.join(' ')}`);
      if (command === 'git' && args[0] === 'rev-parse') return { status: 0, stdout: head, stderr: '' };
      if (command === 'git' && args[0] === 'rev-list') return { status: 0, stdout: head, stderr: '' };
      if (command === 'git' && args[0] === 'status') return { status: 0, stdout: '', stderr: '' };
      if (command === 'git' && args[0] === 'remote') {
        return { status: 0, stdout: 'https://github.com/example/release-repo.git\n', stderr: '' };
      }
      if (command === 'git' && args[0] === 'ls-remote') {
        return { status: 0, stdout: `${head}\trefs/tags/v0.1.999^{}\n`, stderr: '' };
      }
      if (command === 'gh' && args[0] === 'api') return args[1]?.includes('/releases/tags/')
        ? { status: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' }
        : { status: 0, stdout: JSON.stringify(args[1]?.includes('/releases?') ? [] : { full_name: 'example/release-repo' }), stderr: '' };
      if (args[0] === 'scripts/classify-tests.mjs') {
        return { status: 0, stdout: '[test-classification] manifest matches resource-owning source markers\n', stderr: '' };
      }
      if (command === 'ps') return { status: 0, stdout: '', stderr: '' };
      return { status: 0, stdout: `${command} test-version\n`, stderr: '' };
    };

    const receipt = performShipPreflight({ root, version: '0.1.999', env, run });

    expect(receipt.head).toBe(head);
    expect(calls).toContain(`${process.execPath} scripts/classify-tests.mjs --check`);
  });

  it('keeps an intentionally disabled intake independent from ship readiness', () => {
    const { root, head, env } = fixture();
    env.O8_INTAKE_RECONCILIATION = 'disabled';
    const run = (command: string, args: string[]) => {
      if (command === 'git' && args[0] === 'rev-parse') return { status: 0, stdout: head, stderr: '' };
      if (command === 'git' && args[0] === 'rev-list') return { status: 0, stdout: head, stderr: '' };
      if (command === 'git' && args[0] === 'status') return { status: 0, stdout: '', stderr: '' };
      if (command === 'git' && args[0] === 'remote') {
        return { status: 0, stdout: 'https://github.com/example/release-repo.git\n', stderr: '' };
      }
      if (command === 'git' && args[0] === 'ls-remote') {
        return { status: 0, stdout: `${head}\trefs/tags/v0.1.999^{}\n`, stderr: '' };
      }
      if (command === 'gh' && args[0] === 'api') return args[1]?.includes('/releases/tags/')
        ? { status: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' }
        : { status: 0, stdout: JSON.stringify(args[1]?.includes('/releases?') ? [] : { full_name: 'example/release-repo' }), stderr: '' };
      if (command === 'ps') return { status: 0, stdout: '', stderr: '' };
      return { status: 0, stdout: `${command} test-version\n`, stderr: '' };
    };

    const receipt = performShipPreflight({ root, version: '0.1.999', env, run });

    expect(receipt.intakeReconciliation).toMatchObject({ status: 'disabled' });
  });
});
