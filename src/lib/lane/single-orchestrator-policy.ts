import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { prepareWorkerSandbox } from '@/lib/runtimes/shared/owned-session/sandbox';

const CONTROL_ENV_KEYS = [
  'O8_API_TOKEN',
  'O8_WORKER_TOKEN',
  'O8_WORKER_PACKET_ID',
  'O8_TAURI_MCP_SOCKET',
  'TAURI_MCP_AUTH_TOKEN',
  'WS_TOKEN',
  'TMUX',
  'TMUX_PANE',
] as const;

export function singleOrchestratorEnvironment(
  base: NodeJS.ProcessEnv,
  codexHome: string,
): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const key of CONTROL_ENV_KEYS) delete env[key];
  return {
    ...env,
    CODEX_HOME: codexHome,
    // Keep the CLI from falling through to an operator credential when this
    // value is present. If a shell unsets it, Seatbelt still denies token files.
    O8_API_TOKEN: 'single-mode-no-operator-authority',
  };
}

function resolvePrivateCodexSource(binary: string): {
  nativeBinary: string;
  denyReadPaths: string[];
  denyExecPaths: string[];
} {
  const resolvedBinary = realpathSync(binary);
  if (!resolvedBinary.endsWith('.js')) {
    return {
      nativeBinary: resolvedBinary,
      denyReadPaths: [binary, resolvedBinary],
      denyExecPaths: [binary, resolvedBinary],
    };
  }

  const packageRoot = dirname(dirname(resolvedBinary));
  const target = process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  const packageArch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const candidates = [
    join(packageRoot, 'node_modules', '@openai', `codex-darwin-${packageArch}`, 'vendor', target, 'bin', 'codex'),
    join(packageRoot, 'vendor', target, 'bin', 'codex'),
  ];
  const nativeBinary = candidates.find(existsSync);
  if (!nativeBinary) {
    throw new Error(`Unable to locate Codex native executable behind ${binary}`);
  }
  return {
    nativeBinary: realpathSync(nativeBinary),
    denyReadPaths: [binary, resolvedBinary, packageRoot],
    denyExecPaths: [binary, resolvedBinary, packageRoot],
  };
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function discoverCodexInstallations(binary: string, env: NodeJS.ProcessEnv): {
  cliPaths: string[];
  denyReadPaths: string[];
  denyExecPaths: string[];
} {
  const userApplications = env.HOME ? join(env.HOME, 'Applications') : null;
  const candidates = uniqueStrings([
    binary,
    ...(env.PATH ?? '').split(delimiter).filter(Boolean).map((entry) => join(entry, 'codex')),
    '/Applications/ChatGPT.app/Contents/Resources/codex',
    '/Applications/ChatGPT.app/Contents/Resources/codex-code-mode-host',
    '/Applications/Codex.app/Contents/Resources/codex',
    ...(userApplications ? [
      join(userApplications, 'ChatGPT.app', 'Contents', 'Resources', 'codex'),
      join(userApplications, 'Codex.app', 'Contents', 'Resources', 'codex'),
    ] : []),
  ].filter(existsSync));
  const resolved = candidates.map((candidate) => {
    try {
      return resolvePrivateCodexSource(candidate);
    } catch {
      const exact = realpathSync(candidate);
      return { nativeBinary: exact, denyReadPaths: [candidate, exact], denyExecPaths: [candidate, exact] };
    }
  });
  return {
    cliPaths: uniqueStrings(candidates.flatMap((candidate, index) => [
      candidate, realpathSync(candidate), resolved[index].nativeBinary,
    ])),
    denyReadPaths: uniqueStrings(resolved.flatMap((item) => item.denyReadPaths)),
    denyExecPaths: uniqueStrings(resolved.flatMap((item) => item.denyExecPaths)),
  };
}

export async function prepareSingleOrchestratorLaunch(input: {
  repoPath: string;
  codexHome: string;
  binary: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}): Promise<{
  binary: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  profileText: string;
  profilePath: string;
  overlayPath: string;
  rulesPath: string;
  guardPath: string;
  launchBinaryPath: string;
  supervisorPath: string;
  cleanup: () => void;
}> {
  const launchId = `${process.pid}-${randomUUID()}`;
  const launchesRoot = join(input.codexHome, '.single-turns');
  const launchRoot = join(launchesRoot, launchId);
  const overlayHome = join(launchRoot, 'codex-home');
  const privateDir = join(launchRoot, 'private');
  const guardBinDir = join(overlayHome, 'bin');
  const rulesDir = join(overlayHome, 'rules');
  const launchBinaryPath = join(privateDir, '.codex-main');
  const supervisorPath = join(privateDir, '.single-supervisor.mjs');
  const cleanup = () => rmSync(launchRoot, { recursive: true, force: true });

  try {
    mkdirSync(privateDir, { recursive: true, mode: 0o700 });
    mkdirSync(guardBinDir, { recursive: true, mode: 0o700 });
    mkdirSync(rulesDir, { recursive: true, mode: 0o700 });
    for (const fileName of ['auth.json', 'installation_id', 'version.json']) {
      const source = join(input.codexHome, fileName);
      if (existsSync(source)) copyFileSync(source, join(overlayHome, fileName));
    }
    const overlayAuth = join(overlayHome, 'auth.json');
    if (existsSync(overlayAuth)) chmodSync(overlayAuth, 0o600);

    const sessionsDir = join(input.codexHome, 'sessions');
    mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
    symlinkSync(sessionsDir, join(overlayHome, 'sessions'), 'dir');

    const source = resolvePrivateCodexSource(input.binary);
    const installations = discoverCodexInstallations(input.binary, input.env);
    copyFileSync(source.nativeBinary, launchBinaryPath, fsConstants.COPYFILE_FICLONE);
    chmodSync(launchBinaryPath, 0o700);
    const blockedPrefixes = [
      ['codex'],
      ...installations.cliPaths.map((path) => [path]),
      ['/usr/local/bin/codex'],
      ['/opt/homebrew/bin/codex'],
      ...installations.cliPaths.filter((path) => path.endsWith('.js')).flatMap((path) => [
        [process.execPath, path],
        ['node', path],
      ]),
      ['npx', 'codex'],
      ['npm', 'exec', 'codex'],
      ['pnpm', 'exec', 'codex'],
      ['bunx', 'codex'],
      ['yarn', 'codex'],
    ].filter((prefix, index, all) => (
      all.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(prefix)) === index
    ));
    const rulesPath = join(rulesDir, 'single-mode.rules');
    writeFileSync(rulesPath, `${blockedPrefixes.map((pattern) => (
      `prefix_rule(pattern=${JSON.stringify(pattern)}, decision="forbidden", justification="Single mode blocks recursive Codex launches")`
    )).join('\n')}\n`, { mode: 0o600 });

    const guardPath = join(guardBinDir, 'codex');
    writeFileSync(guardPath, '#!/bin/sh\necho "Single mode blocks recursive Codex launches" >&2\nexit 126\n', { mode: 0o700 });
    chmodSync(guardPath, 0o700);
    writeFileSync(supervisorPath, [
      "import { spawn } from 'node:child_process';",
      "import { chmodSync, rmSync } from 'node:fs';",
      "import { Transform } from 'node:stream';",
      'const [, , launchBinary, cleanupRoot, sandboxBinary, ...sandboxArgs] = process.argv;',
      "const child = spawn(sandboxBinary, sandboxArgs, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });",
      'let sealed = false;',
      'let sealFailed = false;',
      'const relay = new Transform({ transform(chunk, _encoding, callback) {',
      '  if (!sealed) {',
      '    try { chmodSync(launchBinary, 0o000); sealed = true; }',
      '    catch (error) { sealFailed = true; child.kill(\'SIGTERM\'); callback(error); return; }',
      '  }',
      '  callback(null, chunk);',
      '} });',
      'relay.on(\'error\', (error) => { console.error(`Single mode seal failed: ${error.message}`); });',
      'child.stdout.pipe(relay).pipe(process.stdout);',
      'child.stderr.pipe(process.stderr);',
      "child.once('error', (error) => { console.error(error); process.exitCode = 1; });",
      "for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {",
      '  process.on(signal, () => { if (!child.killed) child.kill(signal); });',
      '}',
      "child.once('exit', (code, signal) => {",
      '  try { rmSync(cleanupRoot, { recursive: true, force: true }); } catch {}',
      "  if (signal && !sealFailed) { process.removeAllListeners(signal); process.kill(process.pid, signal); }",
      '  else process.exitCode = sealFailed ? 1 : (code ?? 1);',
      '});',
      '',
    ].join('\n'), { mode: 0o700 });
    chmodSync(supervisorPath, 0o700);

    const dataDirs = [process.env.CORTEX_IDE_DATA_DIR, process.env.O8_DATA_DIR]
      .filter((value): value is string => Boolean(value?.trim()));
    const prepared = await prepareWorkerSandbox({
      runId: launchId,
      profileDir: launchRoot,
      cwd: input.repoPath,
      repoPath: input.repoPath,
      binary: launchBinaryPath,
      args: input.args,
      extraDenyPaths: dataDirs,
      // Codex resume state lives under ~/.o8. Re-open only this runtime home,
      // then close the files that can reintroduce operator-controlled tools.
      trustedReadWritePaths: [input.codexHome],
      finalDenyPaths: [
        ...installations.denyReadPaths,
        launchesRoot,
        join(input.codexHome, 'config.toml'),
        join(input.codexHome, 'requirements.toml'),
        join(input.codexHome, 'managed_config.toml'),
        join(input.codexHome, 'mcp-oauth-locks'),
        join(input.codexHome, 'plugins'),
        join(input.codexHome, 'shell_snapshots'),
      ],
      finalAllowReadWritePaths: [overlayHome],
      finalDenyExecPaths: [...installations.denyExecPaths, launchesRoot],
      finalDenyExecNamePrefixes: ['codex'],
      finalDenyReadBasenames: ['codex', 'codex.js'],
      finalDenyWritePaths: [launchesRoot],
      finalImmutableWritePaths: [rulesPath, guardPath],
      finalAllowReadPaths: [launchBinaryPath],
      finalAllowExecPaths: [launchBinaryPath],
    });
    const env = singleOrchestratorEnvironment(input.env, overlayHome);
    env.CODEX_SQLITE_HOME = input.codexHome;
    env.PATH = `${guardBinDir}${delimiter}${env.PATH ?? ''}`;
    return {
      binary: process.execPath,
      args: [supervisorPath, launchBinaryPath, launchRoot, prepared.binary, ...prepared.args],
      env,
      profileText: prepared.profileText,
      profilePath: prepared.profilePath,
      overlayPath: overlayHome,
      rulesPath,
      guardPath,
      launchBinaryPath,
      supervisorPath,
      cleanup,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}
