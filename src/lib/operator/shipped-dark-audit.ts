import 'server-only';

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { readOperatorDefaultsTomlForUpdate } from '@/lib/settings/operator-defaults-store';
import {
  getOperatorDefaultsTomlKey,
  OPERATOR_EXPERIMENTAL_OR_OPT_IN_FLAG_KEYS,
} from '@/lib/settings/toml';
import { OPERATOR_DEFAULTS_FALLBACK, type OperatorDefaults } from './defaults';

const execFileAsync = promisify(execFile);
const DEFAULTS_FILE = 'src/lib/operator/defaults.ts';
const FLAG_DEFAULT_FILES: Partial<Record<keyof OperatorDefaults, string>> = {
  apfsDependencyImages: 'src/lib/operator/apfs-dependency-images-default.ts',
  broadcastCommentary: 'src/lib/operator/broadcast-commentary-defaults.ts',
  broadcastVoice: 'src/lib/operator/broadcast-commentary-defaults.ts',
};

interface ReleaseTag {
  tag: string;
  version: string;
}

export interface ShippedButDarkFlag {
  key: keyof OperatorDefaults;
  tomlKey: string;
  codeDefault: unknown;
  operatorValue: unknown;
  operatorValueSource: 'file' | 'default';
  defaultFile: string;
  landedRelease: string | null;
  darkForReleases: number | null;
}

export interface ShippedButDarkAudit {
  currentRelease: string | null;
  flags: ShippedButDarkFlag[];
}

function releaseVersion(tag: string): string | null {
  const match = tag.match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

function compareReleaseVersions(left: ReleaseTag, right: ReleaseTag): number {
  const leftParts = left.version.split('.').map(Number);
  const rightParts = right.version.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index] - rightParts[index];
    if (difference !== 0) return difference;
  }
  return 0;
}

function releaseTags(raw: string): ReleaseTag[] {
  const releases: ReleaseTag[] = [];
  const indexes = new Map<string, number>();
  for (const tag of raw.split('\n').map((value) => value.trim()).filter(Boolean)) {
    const version = releaseVersion(tag);
    if (!version) continue;
    const existingIndex = indexes.get(version);
    if (existingIndex === undefined) {
      indexes.set(version, releases.length);
      releases.push({ tag, version });
    } else if (tag.startsWith('v') && !releases[existingIndex].tag.startsWith('v')) {
      releases[existingIndex] = { tag, version };
    }
  }
  return releases.sort(compareReleaseVersions);
}

function isInactive(value: unknown): boolean {
  return value === false || value === 'off';
}

async function git(repoPath: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, {
    cwd: repoPath,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  return result.stdout;
}

async function findLanding(
  repoPath: string,
  key: keyof OperatorDefaults,
  defaultFile: string,
  releases: ReleaseTag[],
): Promise<Pick<ShippedButDarkFlag, 'landedRelease' | 'darkForReleases'>> {
  const commits = (await git(repoPath, [
    'log',
    '--follow',
    '--reverse',
    '--format=%H',
    `-S${String(key)}:`,
    '--',
    defaultFile,
  ])).trim().split('\n').filter(Boolean);
  const landingCommit = commits[0];
  if (!landingCommit || releases.length === 0) {
    return { landedRelease: null, darkForReleases: null };
  }

  const containingVersions = new Set(releaseTags(await git(repoPath, [
    'tag',
    '--contains',
    landingCommit,
    '--merged',
    'HEAD',
    '--sort=version:refname',
  ])).map((release) => release.version));
  const landingIndex = releases.findIndex((release) => containingVersions.has(release.version));
  if (landingIndex < 0) return { landedRelease: null, darkForReleases: null };
  return {
    landedRelease: releases[landingIndex].tag,
    darkForReleases: releases.length - landingIndex - 1,
  };
}

/**
 * Lists settings-backed feature flags that remain inactive in both the shipped
 * code default and the operator's persisted settings.toml state.
 */
export async function auditShippedButDarkFlags(options: {
  repoPath?: string;
} = {}): Promise<ShippedButDarkAudit> {
  const repoPath = options.repoPath ?? process.cwd();
  const persisted = (await readOperatorDefaultsTomlForUpdate()).values;
  const releases = releaseTags(await git(repoPath, [
    'tag',
    '--merged',
    'HEAD',
    '--sort=version:refname',
  ]));

  const darkFlags = OPERATOR_EXPERIMENTAL_OR_OPT_IN_FLAG_KEYS.filter((key) => {
    const codeDefault = OPERATOR_DEFAULTS_FALLBACK[key];
    const operatorValue = persisted[key] ?? codeDefault;
    return isInactive(codeDefault) && isInactive(operatorValue);
  });

  const flags = await Promise.all(darkFlags.map(async (key): Promise<ShippedButDarkFlag> => {
    const codeDefault = OPERATOR_DEFAULTS_FALLBACK[key];
    const defaultFile = FLAG_DEFAULT_FILES[key] ?? DEFAULTS_FILE;
    return {
      key,
      tomlKey: getOperatorDefaultsTomlKey(key),
      codeDefault,
      operatorValue: persisted[key] ?? codeDefault,
      operatorValueSource: persisted[key] === undefined ? 'default' : 'file',
      defaultFile,
      ...await findLanding(repoPath, key, defaultFile, releases),
    };
  }));

  return {
    currentRelease: releases.at(-1)?.tag ?? null,
    flags,
  };
}
