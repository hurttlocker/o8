import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ApfsCowCapability {
  macos: boolean;
  apfs: boolean;
  sameVolume: boolean;
  canCowClone: boolean;
  sourceDevice?: string;
  targetDevice?: string;
  sourceMount?: string;
  targetMount?: string;
  reason?: string;
}

interface DfInfo {
  device: string;
  mount: string;
}

async function pathExists(target: string) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function nearestExistingPath(target: string): Promise<string> {
  let current = path.resolve(target);
  while (!(await pathExists(current))) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

async function dfInfo(target: string): Promise<DfInfo | null> {
  const existing = await nearestExistingPath(target);
  try {
    const { stdout } = await execFileAsync('df', ['-P', existing], {
      windowsHide: true,
      timeout: 5000,
    });
    const line = stdout.trim().split('\n')[1];
    if (!line) return null;
    const parts = line.trim().split(/\s+/);
    const device = parts[0];
    const mount = parts[parts.length - 1];
    if (!device || !mount) return null;
    return { device, mount };
  } catch {
    return null;
  }
}

async function isApfsMount(mount: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('diskutil', ['info', mount], {
      windowsHide: true,
      timeout: 5000,
    });
    return /\bFile System Personality:\s+APFS\b/.test(stdout)
      || /\bType \(Bundle\):\s+apfs\b/.test(stdout);
  } catch {
    return false;
  }
}

export async function getApfsCowCapability(
  sourcePath: string,
  targetPath?: string,
): Promise<ApfsCowCapability> {
  if (process.platform !== 'darwin') {
    return {
      macos: false,
      apfs: false,
      sameVolume: false,
      canCowClone: false,
      reason: 'APFS copy-on-write workspaces are only available on macOS.',
    };
  }

  const source = await dfInfo(sourcePath);
  if (!source) {
    return {
      macos: true,
      apfs: false,
      sameVolume: false,
      canCowClone: false,
      reason: 'Unable to inspect the source volume.',
    };
  }

  const target = targetPath ? await dfInfo(targetPath) : source;
  if (!target) {
    return {
      macos: true,
      apfs: false,
      sameVolume: false,
      sourceDevice: source.device,
      sourceMount: source.mount,
      canCowClone: false,
      reason: 'Unable to inspect the workspace volume.',
    };
  }

  const apfs = await isApfsMount(source.mount);
  const sameVolume = source.device === target.device;

  return {
    macos: true,
    apfs,
    sameVolume,
    sourceDevice: source.device,
    targetDevice: target.device,
    sourceMount: source.mount,
    targetMount: target.mount,
    canCowClone: apfs && sameVolume,
    reason: !apfs
      ? 'The source repository is not on an APFS volume.'
      : !sameVolume
        ? 'The workspace destination is not on the same volume as the source repository.'
        : undefined,
  };
}

