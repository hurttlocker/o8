// Measurement targets for the interaction harness.
//
// `source`  — build the stack from this checkout. Fast to iterate, but it is a
//             development artifact: absolute budgets do not apply to it.
// `release` — run the EXACT packaged server out of a shipped .app bundle (or an
//             extracted release artifact) against an isolated data dir. This is
//             the lane that produces the per-release baselines #1697 requires;
//             two source stacks from the same checkout are not two releases.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { startIsolatedStack } from '../terminal-workload/runtime.mjs';

export const DEFAULT_RELEASE_APP_PATH = '/Applications/o8.app';
const releaseIdentityCache = new Map();

export function parseTargetOption(raw) {
  const value = String(raw ?? 'source').trim();
  if (value === 'source') return { kind: 'source', appPath: null };
  if (value === 'release') return { kind: 'release', appPath: DEFAULT_RELEASE_APP_PATH };
  if (value.startsWith('release:')) return { kind: 'release', appPath: path.resolve(value.slice('release:'.length)) };
  throw new Error(`unknown --target ${value}; expected source, release, or release:<path to .app or extracted artifact>`);
}

// Accepts either a .app bundle or an already-extracted artifact directory that
// contains the bundled server.
export function resolveReleaseServerDir(appPath) {
  const candidates = [
    path.join(appPath, 'Contents/Resources/server'),
    path.join(appPath, 'Resources/server'),
    path.join(appPath, 'server'),
    appPath,
  ];
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, 'server.js'))) ?? null;
}

function sha256File(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function plistValue(appPath, key) {
  try {
    return execFileSync('plutil', ['-extract', key, 'raw', '-o', '-', path.join(appPath, 'Contents/Info.plist')], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch {
    return null;
  }
}

function verifySignedArtifact(appPath) {
  const codesign = spawnSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], { encoding: 'utf8' });
  const gatekeeper = spawnSync('spctl', ['--assess', '--type', 'execute', '--verbose=4', appPath], { encoding: 'utf8' });
  const gatekeeperOutput = `${gatekeeper.stdout ?? ''}\n${gatekeeper.stderr ?? ''}`;
  const gatekeeperSource = gatekeeperOutput.match(/source=([^\n]+)/)?.[1]?.trim() ?? null;
  return {
    strictCodesign: codesign.status === 0,
    gatekeeperAccepted: gatekeeper.status === 0,
    gatekeeperNotarized: gatekeeper.status === 0 && gatekeeperSource === 'Notarized Developer ID',
    gatekeeperSource,
  };
}

export function releaseArtifactIdentity(appPath, { archiveSha256 = null, releaseGitSha = null } = {}) {
  const cacheKey = `${path.resolve(appPath)}:${archiveSha256 ?? ''}:${releaseGitSha ?? ''}`;
  if (releaseIdentityCache.has(cacheKey)) return releaseIdentityCache.get(cacheKey);
  const serverDir = resolveReleaseServerDir(appPath);
  if (!serverDir) {
    return {
      appPath,
      serverDir: null,
      bundleVersion: null,
      complete: false,
      identityProblems: [`no packaged server.js under ${appPath}`],
      unavailableReason: `no packaged server.js under ${appPath}`,
    };
  }
  const bundleVersion = plistValue(appPath, 'CFBundleShortVersionString');
  const bundleBuildVersion = plistValue(appPath, 'CFBundleVersion');
  const bundleIdentifier = plistValue(appPath, 'CFBundleIdentifier');
  const executableName = plistValue(appPath, 'CFBundleExecutable');
  const executablePath = executableName ? path.join(appPath, 'Contents/MacOS', executableName) : null;
  const serverEntryPath = path.join(serverDir, 'server.js');
  let buildId = null;
  try {
    buildId = fs.readFileSync(path.join(serverDir, '.next/BUILD_ID'), 'utf8').trim() || null;
  } catch { buildId = null; }
  const executableSha256 = executablePath && fs.existsSync(executablePath) ? sha256File(executablePath) : null;
  const serverEntrySha256 = fs.existsSync(serverEntryPath) ? sha256File(serverEntryPath) : null;
  const signing = verifySignedArtifact(appPath);
  const normalizedArchiveSha256 = typeof archiveSha256 === 'string' && /^[0-9a-f]{64}$/i.test(archiveSha256)
    ? archiveSha256.toLowerCase()
    : null;
  const normalizedReleaseGitSha = typeof releaseGitSha === 'string' && /^[0-9a-f]{40}$/i.test(releaseGitSha)
    ? releaseGitSha.toLowerCase()
    : null;
  const identityProblems = [
    !bundleVersion ? 'bundle version is missing' : null,
    !bundleBuildVersion ? 'bundle build version is missing' : null,
    !bundleIdentifier ? 'bundle identifier is missing' : null,
    !executableName ? 'bundle executable name is missing' : null,
    !executableSha256 ? 'packaged Mach-O SHA-256 is missing' : null,
    !serverEntrySha256 ? 'packaged server entry SHA-256 is missing' : null,
    !buildId ? 'packaged Next build ID is missing' : null,
    !normalizedArchiveSha256 ? 'release archive SHA-256 provenance is missing' : null,
    !normalizedReleaseGitSha ? 'release Git commit SHA provenance is missing' : null,
    !signing.strictCodesign ? 'strict codesign verification failed' : null,
    !signing.gatekeeperAccepted ? 'Gatekeeper did not accept the artifact' : null,
    !signing.gatekeeperNotarized ? 'Gatekeeper did not identify the artifact as Notarized Developer ID' : null,
  ].filter(Boolean);
  const identityMaterial = {
    bundleVersion,
    bundleBuildVersion,
    bundleIdentifier,
    executableName,
    executableSha256,
    serverEntrySha256,
    buildId,
    archiveSha256: normalizedArchiveSha256,
    releaseGitSha: normalizedReleaseGitSha,
  };
  const identity = {
    appPath,
    serverDir,
    ...identityMaterial,
    targetDigestSha256: createHash('sha256').update(JSON.stringify(identityMaterial)).digest('hex'),
    signing,
    complete: identityProblems.length === 0,
    identityProblems,
    unavailableReason: identityProblems.length > 0 ? identityProblems.join('; ') : null,
  };
  releaseIdentityCache.set(cacheKey, identity);
  return identity;
}

export function packagedTargetIdentityProblems(target, stack) {
  if (stack?.buildMode !== 'packaged') return [];
  const artifact = stack.releaseArtifact;
  const problems = [...(artifact?.identityProblems ?? ['packaged release artifact identity is missing'])];
  if (target?.appVersion !== artifact?.bundleVersion) {
    problems.push(`running target version ${target?.appVersion ?? 'missing'} does not match bundle version ${artifact?.bundleVersion ?? 'missing'}`);
  }
  if (target?.buildGitSha !== artifact?.releaseGitSha) {
    problems.push(`measured release Git SHA ${target?.buildGitSha ?? 'missing'} does not match artifact provenance ${artifact?.releaseGitSha ?? 'missing'}`);
  }
  if (target?.serverReportedBuildGitSha && target.serverReportedBuildGitSha !== artifact?.releaseGitSha) {
    problems.push(`server-reported build Git SHA ${target.serverReportedBuildGitSha} does not match release provenance ${artifact?.releaseGitSha ?? 'missing'}`);
  }
  if (!target?.platform) problems.push('running target platform is missing');
  return problems;
}

async function freePort(reserved) {
  while (true) {
    const port = await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.unref();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const selected = typeof address === 'object' && address ? address.port : 0;
        server.close(() => resolve(selected));
      });
    });
    if (port > 0 && !reserved.has(port)) return port;
  }
}

function reservedPorts(root) {
  try {
    const source = fs.readFileSync(path.join(root, 'src/lib/panel/port-constants.ts'), 'utf8');
    return new Set(Array.from(source.matchAll(/\b(\d{5})\b/g), (match) => Number(match[1])));
  } catch {
    return new Set();
  }
}

function collectOutput(child) {
  let output = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream?.setEncoding('utf8');
    stream?.on('data', (chunk) => { output = `${output}${chunk}`.slice(-200_000); });
  }
  return () => output;
}

function stopProcessGroup(child) {
  if (!child || child.exitCode !== null) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ }
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
}

async function waitForHealth(url, child, log, headers, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${url} exited ${child.exitCode}\n${log().slice(-2000)}`);
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
    } catch { /* booting */ }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`timed out waiting for ${url}\n${log().slice(-2000)}`);
}

export async function startReleaseArtifactStack(root, fixture, appPath, {
  timeoutMs = 90_000,
  runTag = null,
  archiveSha256 = null,
  releaseGitSha = null,
} = {}) {
  const identity = releaseArtifactIdentity(appPath, { archiveSha256, releaseGitSha });
  if (!identity.serverDir) throw new Error(identity.unavailableReason);
  const reserved = reservedPorts(root);
  const apiPort = await freePort(reserved);
  let wsPort = await freePort(reserved);
  while (wsPort === apiPort) wsPort = await freePort(reserved);
  const token = randomBytes(32).toString('hex');
  fs.writeFileSync(path.join(fixture.dataDir, 'ws-token'), token, { mode: 0o600 });
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(apiPort),
    O8_API_PORT: String(apiPort),
    WS_PORT: String(wsPort),
    O8_WS_PORT: String(wsPort),
    O8_DATA_DIR: fixture.dataDir,
    CORTEX_IDE_DATA_DIR: fixture.dataDir,
    WS_TOKEN: token,
    O8_INTERACTION_RUN_TAG: runTag ?? '',
  };
  delete env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  delete env.CLERK_PUBLISHABLE_KEY;

  const next = spawn(process.execPath, [path.join(identity.serverDir, 'server.js')], {
    cwd: identity.serverDir, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ws = spawn(process.execPath, [path.join(identity.serverDir, 'ws-server.mjs')], {
    cwd: identity.serverDir, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const nextLog = collectOutput(next);
  const wsLog = collectOutput(ws);
  const headers = { Authorization: `Bearer ${token}` };
  try {
    await Promise.all([
      waitForHealth(`http://127.0.0.1:${apiPort}/api/panel/status`, next, nextLog, headers, timeoutMs),
      waitForHealth(`http://127.0.0.1:${wsPort}/health`, ws, wsLog, {}, timeoutMs),
    ]);
  } catch (error) {
    stopProcessGroup(next);
    stopProcessGroup(ws);
    throw error;
  }
  return {
    apiPort,
    wsPort,
    token,
    buildMode: 'packaged',
    releaseArtifact: identity,
    nextPid: next.pid,
    wsPid: ws.pid,
    close: async () => {
      stopProcessGroup(next);
      stopProcessGroup(ws);
      await new Promise((resolve) => setTimeout(resolve, 300));
      fs.rmSync(fixture.dataDir, { recursive: true, force: true });
    },
  };
}

export async function startTargetStack(root, fixture, target, requestedBuildMode, options = {}) {
  if (target.kind === 'release') return startReleaseArtifactStack(root, fixture, target.appPath, options);
  const stack = await startIsolatedStack(root, fixture, requestedBuildMode, options);
  return { ...stack, releaseArtifact: null };
}
