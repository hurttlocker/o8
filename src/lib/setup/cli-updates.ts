import { compareCliVersions, resolveCli } from '@/lib/runtimes/shared/cli-resolver';
import { inspectCliInstallation } from './cli-installation';

export type CliUpdateStatus = 'current' | 'update-available' | 'unknown' | 'not-installed';

export interface CliUpdateRecord {
  runtimeId: string;
  label: string;
  installedVersion: string | null;
  latestVersion: string | null;
  status: CliUpdateStatus;
  updateUrl: string;
  selectedPath: string | null;
  manager?: 'npm' | 'native' | 'homebrew' | 'manual';
}

type CliUpdateSpec = {
  runtimeId: string;
  label: string;
  binaryName: string;
  envOverride: string;
  extraEnvOverrides?: string[];
  versionArgs?: string[];
  release: { kind: 'npm'; packageName: string } | { kind: 'github'; repository: string }
    | { kind: 'claude-native'; channel: 'stable' | 'latest' }
    | { kind: 'grok-native' }
    | { kind: 'homebrew'; package: string; packageKind: 'cask' | 'formula' };
  updateUrl: string;
};

// Compare each CLI with its own release channel. Antigravity is a separate Go
// binary; the Gemini npm package is not an Antigravity update.
const UPDATE_SPECS: CliUpdateSpec[] = [
  {
    runtimeId: 'codex', label: 'Codex CLI', binaryName: 'codex',
    envOverride: 'O8_CODEX_BIN', release: { kind: 'npm', packageName: '@openai/codex' },
    updateUrl: 'https://learn.chatgpt.com/docs/codex/cli',
  },
  {
    runtimeId: 'claude-code', label: 'Claude Code', binaryName: 'claude',
    envOverride: 'O8_CLAUDE_CODE_BIN', extraEnvOverrides: ['CLAUDE_BIN'],
    release: { kind: 'npm', packageName: '@anthropic-ai/claude-code' },
    updateUrl: 'https://docs.anthropic.com/en/docs/claude-code/setup',
  },
  {
    runtimeId: 'grok', label: 'Grok Build', binaryName: 'grok', envOverride: 'O8_GROK_BIN',
    versionArgs: ['--no-auto-update', '--version'], release: { kind: 'npm', packageName: '@xai-official/grok' },
    updateUrl: 'https://docs.x.ai/build/cli/reference',
  },
  {
    runtimeId: 'antigravity', label: 'Antigravity CLI', binaryName: 'agy',
    envOverride: 'O8_ANTIGRAVITY_BIN',
    release: { kind: 'github', repository: 'google-antigravity/antigravity-cli' },
    updateUrl: 'https://antigravity.google/docs/getting-started?tab=cli',
  },
  {
    runtimeId: 'gemini', label: 'Gemini CLI', binaryName: 'gemini',
    envOverride: 'O8_GEMINI_BIN', release: { kind: 'npm', packageName: '@google/gemini-cli' },
    updateUrl: 'https://github.com/google-gemini/gemini-cli',
  },
];

const LATEST_TTL_MS = 6 * 60 * 60_000;
const latestCache = new Map<string, { version: string; checkedAt: number }>();

function parseVersion(value: string | undefined): string | null {
  return value?.match(/(?<!\d)(\d+\.\d+\.\d+)\b/)?.[1] ?? null;
}

async function latestVersion(release: CliUpdateSpec['release'], refresh: boolean): Promise<string | null> {
  const cacheKey = JSON.stringify(release);
  const cached = latestCache.get(cacheKey);
  if (!refresh && cached && Date.now() - cached.checkedAt < LATEST_TTL_MS) return cached.version;
  try {
    const url = release.kind === 'npm'
      ? `https://registry.npmjs.org/${encodeURIComponent(release.packageName)}/latest`
      : release.kind === 'github' ? `https://api.github.com/repos/${release.repository}/releases/latest`
        : release.kind === 'homebrew' ? `https://formulae.brew.sh/api/${release.packageKind}/${release.package}.json`
          : release.kind === 'grok-native' ? 'https://x.ai/cli/stable' : `https://downloads.claude.ai/claude-code-releases/${release.channel}`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(3_000),
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!response.ok) return null;
    const body = release.kind === 'claude-native' || release.kind === 'grok-native' ? { version: (await response.text()).trim() }
      : await response.json() as { version?: unknown; tag_name?: unknown; versions?: { stable?: unknown } };
    const rawVersion = release.kind === 'github' ? body.tag_name
      : release.kind === 'homebrew' && release.packageKind === 'formula' ? body.versions?.stable : body.version;
    const version = typeof rawVersion === 'string'
      && (release.kind !== 'npm' || /^\d+\.\d+\.\d+$/.test(rawVersion))
      ? parseVersion(rawVersion) : null;
    if (version) latestCache.set(cacheKey, { version, checkedAt: Date.now() });
    return version;
  } catch {
    return null;
  }
}

export async function checkCliUpdates(refresh = false, runtimeId?: string): Promise<CliUpdateRecord[]> {
  return Promise.all(UPDATE_SPECS.filter((spec) => !runtimeId || spec.runtimeId === runtimeId).map(async (spec): Promise<CliUpdateRecord> => {
    let installedVersion: string | null = null;
    let selectedPath: string | null = null;
    let manager: CliUpdateRecord['manager'];
    let release = spec.release;
    try {
      const selected = await resolveCli({
        runtimeId: spec.runtimeId,
        binaryName: spec.binaryName,
        envOverride: spec.envOverride,
        extraEnvOverrides: spec.extraEnvOverrides,
        versionArgs: spec.versionArgs,
      });
      selectedPath = selected.path;
      installedVersion = parseVersion(selected.version);
      if (spec.runtimeId === 'codex' || spec.runtimeId === 'claude-code' || spec.runtimeId === 'grok') {
        const install = await inspectCliInstallation(spec.runtimeId, selected);
        manager = install.manager;
        if (install.manager === 'homebrew') release = { kind: 'homebrew', package: install.package!, packageKind: install.packageKind! };
        if (install.manager === 'native' && spec.runtimeId === 'claude-code') release = { kind: 'claude-native', channel: install.channel! };
        if (install.manager === 'native' && spec.runtimeId === 'grok') release = { kind: 'grok-native' };
      }
    } catch {
      // Missing or unprobeable CLIs do not prevent the rest of the report.
    }
    const latest = selectedPath && !(spec.runtimeId === 'grok' && manager === 'manual') ? await latestVersion(release, refresh) : null;
    const status: CliUpdateStatus = !selectedPath
      ? 'not-installed'
      : !installedVersion || !latest
        ? 'unknown'
        : compareCliVersions(installedVersion, latest) < 0
          ? 'update-available'
          : 'current';
    return {
      runtimeId: spec.runtimeId,
      label: spec.label,
      installedVersion,
      latestVersion: latest,
      status,
      updateUrl: spec.updateUrl,
      selectedPath,
      ...(manager ? { manager } : {}),
    };
  }));
}
