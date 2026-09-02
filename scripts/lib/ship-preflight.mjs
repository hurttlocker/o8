import { spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectIntakeReconciliation } from './intake-reconciliation.mjs';

const DEFAULT_MIN_FREE_GIB = 25;

function commandReceipt(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: options.env,
    timeout: options.timeoutMs ?? 15_000,
    windowsHide: true,
  });
  return {
    status: result.status ?? (result.error ? 127 : 0),
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? result.error?.message ?? '',
  };
}

function requireSuccess(receipt, description) {
  if (receipt.status !== 0) {
    const detail = receipt.stderr.trim() || receipt.stdout.trim() || `exit ${receipt.status}`;
    throw new Error(`${description}: ${detail}`);
  }
  return receipt.stdout.trim();
}

function parseRemoteTagHead(output, tag) {
  const lines = output.split('\n').map((line) => line.trim()).filter(Boolean);
  const peeled = lines.find((line) => line.endsWith(`refs/tags/${tag}^{}`));
  const direct = lines.find((line) => line.endsWith(`refs/tags/${tag}`));
  return (peeled ?? direct)?.split(/\s+/, 1)[0] ?? null;
}

function repositoryFromRemote(remoteUrl) {
  const match = remoteUrl.trim().match(/(?:github\.com[/:])([^/\s]+\/[^/\s]+?)(?:\.git)?$/i);
  return match?.[1] ?? null;
}

function checkCredentialNames(env) {
  const required = ['APPLE_SIGNING_IDENTITY', 'APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID'];
  const missing = required.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`missing release credentials: ${missing.join(', ')}`);
  }
  return required;
}

function freeDiskGiB(root) {
  const stats = statfsSync(root);
  return Number(stats.bavail * stats.bsize) / (1024 ** 3);
}

function assertNoCompetingBuilds(run, root, env) {
  if (process.platform === 'win32') return;
  const receipt = run('ps', ['-axo', 'pid=,ppid=,command='], {
    cwd: root,
    env,
    timeoutMs: 3_000,
  });
  if (receipt.status !== 0) {
    throw new Error(`could not inspect competing release processes: ${receipt.stderr.trim() || `exit ${receipt.status}`}`);
  }
  const buildPattern = /(?:next[^ ]* build|cargo(?: +tauri)? +build|cargo-tauri.*build|scripts\/release\.mjs +--ship)/;
  const competing = receipt.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (!match) return [];
      return [{ pid: Number(match[1]), parentPid: Number(match[2]), command: match[3] }];
    })
    .filter((row) => row.pid !== process.pid && row.pid !== process.ppid)
    .filter((row) => buildPattern.test(row.command));
  if (competing.length > 0) {
    throw new Error(`another ship or build owns the release output (${competing.length} process${competing.length === 1 ? '' : 'es'})`);
  }
}

export function acquireReleaseLock(options = {}) {
  const lockPath = options.lockPath
    ?? process.env.O8_RELEASE_LOCK_PATH?.trim()
    ?? join(tmpdir(), 'o8-release-build-v1.lock');

  if (existsSync(lockPath)) {
    let owner = null;
    try {
      owner = JSON.parse(readFileSync(lockPath, 'utf8'));
    } catch {}
    const pid = Number(owner?.pid);
    let live = false;
    if (Number.isSafeInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        live = true;
      } catch (error) {
        live = error?.code === 'EPERM';
      }
    }
    if (live) {
      throw new Error(`release output is owned by live ship pid ${pid}`);
    }
    rmSync(lockPath, { force: true });
  }

  const fd = openSync(lockPath, 'wx', 0o600);
  writeFileSync(fd, JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
  }));
  let released = false;
  return {
    path: lockPath,
    release() {
      if (released) return;
      released = true;
      try { closeSync(fd); } catch {}
      try { rmSync(lockPath, { force: true }); } catch {}
    },
  };
}

export function performShipPreflight(options) {
  const {
    root,
    version,
    env = process.env,
    run = commandReceipt,
  } = options;
  const tag = `v${version}`;
  const head = requireSuccess(
    run('git', ['rev-parse', 'HEAD'], { cwd: root, env }),
    'could not resolve source HEAD',
  );
  const localTagHead = requireSuccess(
    run('git', ['rev-list', '-n', '1', tag], { cwd: root, env }),
    `local tag ${tag} is missing`,
  );
  if (localTagHead !== head) {
    throw new Error(`local tag ${tag} points to ${localTagHead}, not HEAD ${head}`);
  }
  const dirty = requireSuccess(
    run('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: root, env }),
    'could not inspect the release worktree',
  )
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => !/^(?:[ MADRCU?!]{1,2} )?o8\.md$/.test(line));
  if (dirty.length > 0) {
    throw new Error(`release worktree contains ${dirty.length} non-operator change${dirty.length === 1 ? '' : 's'}`);
  }
  // A test file that lands on main without a PR (a direct-pushed release fix)
  // never runs `npm run test:classification:check` — that gate is PR-CI-only —
  // so a stale manifest reaches the tag unnoticed and turns every open PR's
  // Hermetic Unit Tests job red for a reason unrelated to its diff (#2053).
  // Reuse the exact same script + remedy text CI prints on failure.
  const classification = run(process.execPath, ['scripts/classify-tests.mjs', '--check'], {
    cwd: root,
    env,
    timeoutMs: 15_000,
  });
  if (classification.status !== 0) {
    throw new Error(
      classification.stderr.trim()
        || classification.stdout.trim()
        || `test classification check exited ${classification.status}`,
    );
  }
  const repo = env.O8_RELEASE_REPO?.trim() || repositoryFromRemote(requireSuccess(
    run('git', ['remote', 'get-url', 'origin'], { cwd: root, env }),
    'could not resolve the release repository',
  ));
  if (!repo) {
    throw new Error('origin is not a supported release remote; set O8_RELEASE_REPO explicitly');
  }

  const remoteTags = requireSuccess(
    run('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`], { cwd: root, env }),
    `remote tag ${tag} is missing`,
  );
  const remoteTagHead = parseRemoteTagHead(remoteTags, tag);
  if (remoteTagHead !== head) {
    throw new Error(`remote tag ${tag} points to ${remoteTagHead ?? 'nothing'}, not HEAD ${head}`);
  }

  const release = run('gh', ['release', 'view', tag, '--repo', repo, '--json', 'tagName'], {
    cwd: root,
    env,
    timeoutMs: 20_000,
  });
  if (release.status === 0 && env.O8_RELEASE_CLOBBER !== '1') {
    throw new Error(`release ${tag} already exists; set O8_RELEASE_CLOBBER=1 only for an intentional replacement`);
  }
  const releaseMissing = release.status === 1 && /(?:HTTP\s+404|not found)/i.test(release.stderr);
  if (release.status !== 0 && !releaseMissing) {
    throw new Error(`could not verify whether release ${tag} exists: ${release.stderr.trim() || `exit ${release.status}`}`);
  }

  const credentialNames = checkCredentialNames(env);
  const signingKey = join(env.HOME || '', '.tauri', 'cortex-ide.key');
  if (!env.HOME || !existsSync(signingKey)) {
    throw new Error('Tauri updater signing key is missing');
  }

  const minFreeGiB = Number(env.O8_RELEASE_MIN_FREE_GIB || DEFAULT_MIN_FREE_GIB);
  const availableGiB = freeDiskGiB(root);
  if (!Number.isFinite(minFreeGiB) || minFreeGiB <= 0) {
    throw new Error('O8_RELEASE_MIN_FREE_GIB must be a positive number');
  }
  if (availableGiB < minFreeGiB) {
    throw new Error(`release needs ${minFreeGiB.toFixed(1)} GiB free; only ${availableGiB.toFixed(1)} GiB is available`);
  }

  const toolchains = {};
  for (const [name, command, args] of [
    ['git', 'git', ['--version']],
    ['gh', 'gh', ['--version']],
    ['npm', 'npm', ['--version']],
    ['cargo', 'cargo', ['--version']],
    ['rustc', 'rustc', ['--version']],
    ...(process.platform === 'darwin' ? [
      ['swift', 'swift', ['--version']],
      ['xcodebuild', 'xcodebuild', ['-version']],
    ] : []),
  ]) {
    toolchains[name] = requireSuccess(
      run(command, args, { cwd: root, env, timeoutMs: 10_000 }),
      `${name} toolchain is unavailable`,
    ).split('\n')[0];
  }
  if (Number(process.versions.node.split('.')[0]) !== 22) {
    throw new Error(`Node 22 is required; current runtime is ${process.version}`);
  }

  assertNoCompetingBuilds(run, root, env);

  return {
    schema: 'o8/release-preflight/v1',
    head,
    version,
    tag,
    remoteTagHead,
    releaseAbsent: releaseMissing,
    availableGiB: Number(availableGiB.toFixed(2)),
    minFreeGiB,
    credentialNames,
    signingKeyPresent: true,
    intakeReconciliation: inspectIntakeReconciliation({ env }),
    toolchains: {
      node: process.version,
      ...toolchains,
    },
  };
}

export function runQuickBenchmarkPreflight(options) {
  const {
    root,
    env = process.env,
    run = commandReceipt,
  } = options;
  const receipt = run(process.execPath, ['scripts/bench/quick.mjs', '--ephemeral'], {
    cwd: root,
    env,
    timeoutMs: 120_000,
  });
  if (receipt.status !== 0) {
    return {
      schema: 'o8/benchmark-quick-preflight/v1',
      status: 'unavailable',
      regressions: [],
      missing: [],
      message: receipt.stderr.trim() || receipt.stdout.trim() || `benchmark exited ${receipt.status}`,
    };
  }

  const prefix = 'O8_BENCH_QUICK_RECEIPT=';
  const line = receipt.stdout.split('\n').find((candidate) => candidate.startsWith(prefix));
  if (!line) {
    return {
      schema: 'o8/benchmark-quick-preflight/v1',
      status: 'unavailable',
      regressions: [],
      missing: [],
      message: 'benchmark receipt was missing',
    };
  }
  try {
    const parsed = JSON.parse(line.slice(prefix.length));
    if (parsed?.schema !== 'o8/benchmark-quick-preflight/v1') {
      throw new Error('benchmark receipt schema was invalid');
    }
    return parsed;
  } catch (error) {
    return {
      schema: 'o8/benchmark-quick-preflight/v1',
      status: 'unavailable',
      regressions: [],
      missing: [],
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export const shipPreflightInternals = {
  commandReceipt,
  parseRemoteTagHead,
  repositoryFromRemote,
};
