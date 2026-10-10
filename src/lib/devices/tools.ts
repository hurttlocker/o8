import 'server-only';

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { DeviceError, type DeviceState, type DeviceTool } from './types';

const runFile = promisify(execFile);
export const DEVICE_TOOLS = {
  hub: { name: 'expo-device-hub', version: '0.15.3', entry: 'dist/server/cli.mjs' },
  agent: { name: 'agent-device', version: '0.21.23', entry: 'bin/agent-device.mjs' },
} as const;

export async function executable(path: string): Promise<boolean> {
  try { await access(path, constants.X_OK); return (await stat(path)).isFile(); } catch { return false; }
}

export async function findExecutable(name: string): Promise<string | null> {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    const path = join(dir, name);
    if (await executable(path)) return path;
  }
  return null;
}

export function toolDirectory(root: string, tool: DeviceTool): string {
  const spec = DEVICE_TOOLS[tool];
  return join(root, 'tools', spec.name, spec.version);
}

async function verifiedEntry(directory: string, tool: DeviceTool): Promise<string | null> {
  const spec = DEVICE_TOOLS[tool];
  try {
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    const entry = join(directory, spec.entry);
    return manifest.name === spec.name && manifest.version === spec.version && (await stat(entry)).isFile() ? entry : null;
  } catch { return null; }
}

export async function installedTool(root: string, tool: DeviceTool): Promise<string | null> {
  const spec = DEVICE_TOOLS[tool];
  const dir = toolDirectory(root, tool);
  try {
    if ((await readFile(join(dir, '.install-complete'), 'utf8')).trim() === spec.version) {
      const entry = await verifiedEntry(join(dir, 'node_modules', spec.name), tool);
      if (entry) return entry;
    }
  } catch { /* Also inspect an existing user-installed executable. */ }
  const command = await findExecutable(spec.name);
  if (!command) return null;
  try {
    const target = await realpath(command);
    let dir = dirname(target);
    for (let depth = 0; depth < 5; depth++) {
      const entry = await verifiedEntry(dir, tool);
      if (entry && await realpath(entry) === target) return entry;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch { /* A stale executable is not an installed helper. */ }
  return null;
}

export async function inspectTools(root: string): Promise<DeviceState['tools']> {
  const [hub, agent] = await Promise.all((['hub', 'agent'] as const).map(async (tool) => {
    const installed = Boolean(await installedTool(root, tool));
    return { installed, version: installed ? DEVICE_TOOLS[tool].version : null, requiredVersion: DEVICE_TOOLS[tool].version };
  }));
  return { hub, agent };
}

export function helperEnvironment(root: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'production' };
  for (const key of ['HOME', 'USERPROFILE', 'USER', 'LOGNAME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL',
    'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'ANDROID_AVD_HOME', 'JAVA_HOME', 'DEVELOPER_DIR', 'DISPLAY', 'SystemRoot']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || join(process.env.HOME ?? '', process.platform === 'darwin' ? 'Library/Android/sdk' : 'Android/Sdk');
  env.PATH = [dirname(process.execPath), join(sdk, 'platform-tools'), join(sdk, 'emulator'), process.env.PATH ?? ''].join(delimiter);
  env.EXPO_DEVICE_HUB_STATE_DIR = join(root, 'sessions');
  env.NO_COLOR = '1';
  return env;
}

export async function inspectPlatforms(): Promise<DeviceState['platforms']> {
  let ios = false;
  if (process.platform === 'darwin') {
    const xcrun = await findExecutable('xcrun');
    if (xcrun) {
      try {
        const found = await runFile(xcrun, ['--find', 'simctl'], { timeout: 3_000, maxBuffer: 4096 });
        ios = await executable(found.stdout.trim());
      } catch { /* Command Line Tools alone do not supply a simulator. */ }
    }
  }
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || join(process.env.HOME ?? '', process.platform === 'darwin' ? 'Library/Android/sdk' : 'Android/Sdk');
  const [adb, emulator] = await Promise.all([
    findExecutable('adb').then(async (found) => Boolean(found) || executable(join(sdk, 'platform-tools', 'adb'))),
    findExecutable('emulator').then(async (found) => Boolean(found) || executable(join(sdk, 'emulator', 'emulator'))),
  ]);
  return {
    ios: { available: ios, detail: ios ? 'Xcode simulator tools are available.' : 'iOS simulators require macOS with Xcode and an installed simulator runtime.' },
    android: { available: adb && emulator, detail: adb && emulator ? 'Android platform tools and emulator are available.' : 'Install Android SDK platform tools and emulator in Android Studio to use Android devices.' },
  };
}

export async function stopOwnedChild(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 3_000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.once('error', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}

export async function installTool(root: string, tool: DeviceTool, stage: (text: string) => void, own: (child: ChildProcess | null) => void): Promise<void> {
  if (await installedTool(root, tool)) return;
  const npm = await findExecutable('npm');
  if (!npm) throw new DeviceError('device_npm_missing', 'Install Node.js with npm before installing device helpers.', 409);
  const spec = DEVICE_TOOLS[tool];
  const destination = toolDirectory(root, tool);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(dirname(destination), '.staging-'));
  try {
    stage(`Installing ${spec.name} ${spec.version}`);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(npm, ['install', '--prefix', staging, '--registry=https://registry.npmjs.org', '--no-audit', '--no-fund', '--no-package-lock', '--save-exact', `${spec.name}@${spec.version}`], {
        env: helperEnvironment(root), stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true,
      });
      own(child);
      const timer = setTimeout(() => { void stopOwnedChild(child).then(() => reject(new DeviceError('device_install_timeout', 'Device helper installation timed out. Retry when ready.'))); }, 10 * 60_000);
      child.once('error', () => { clearTimeout(timer); reject(new DeviceError('device_install_failed', 'Device helper installation could not start. Check npm and retry.')); });
      child.once('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new DeviceError('device_install_failed', 'Device helper installation failed. Check your connection and Node.js installation, then retry.'));
      });
    });
    stage(`Verifying ${spec.name}`);
    if (!await verifiedEntry(join(staging, 'node_modules', spec.name), tool)) throw new DeviceError('device_install_invalid', 'Device helper installation did not produce the required version.');
    await writeFile(join(staging, '.install-complete'), `${spec.version}\n`, { mode: 0o600 });
    try { await rename(staging, destination); } catch {
      if (!await installedTool(root, tool)) throw new DeviceError('device_install_publish_failed', 'The device helper could not be saved. An incomplete installation may need attention.');
    }
  } finally { own(null); await rm(staging, { recursive: true, force: true }); }
}
