import { compareCliVersions, resolveCli } from '@/lib/runtimes/shared/cli-resolver';

export type CliUpdateStatus = 'current' | 'update-available' | 'unknown' | 'not-installed';

export interface CliUpdateRecord {
  runtimeId: string;
  label: string;
  installedVersion: string | null;
  latestVersion: string | null;
  status: CliUpdateStatus;
  updateUrl: string;
  selectedPath: string | null;
}

type CliUpdateSpec = {
  runtimeId: string;
  label: string;
  binaryName: string;
  envOverride: string;
  extraEnvOverrides?: string[];
  release: { kind: 'npm'; packageName: string } | { kind: 'github'; repository: string };
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
  const cacheKey = release.kind === 'npm' ? `npm:${release.packageName}` : `github:${release.repository}`;
  const cached = latestCache.get(cacheKey);
  if (!refresh && cached && Date.now() - cached.checkedAt < LATEST_TTL_MS) return cached.version;
  try {
    const url = release.kind === 'npm'
      ? `https://registry.npmjs.org/${encodeURIComponent(release.packageName)}/latest`
      : `https://api.github.com/repos/${release.repository}/releases/latest`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(3_000),
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!response.ok) return null;
    const body = await response.json() as { version?: unknown; tag_name?: unknown };
    const rawVersion = release.kind === 'npm' ? body.version : body.tag_name;
    const version = typeof rawVersion === 'string' ? parseVersion(rawVersion) : null;
    if (version) latestCache.set(cacheKey, { version, checkedAt: Date.now() });
    return version;
  } catch {
    return null;
  }
}

export async function checkCliUpdates(refresh = false): Promise<CliUpdateRecord[]> {
  return Promise.all(UPDATE_SPECS.map(async (spec): Promise<CliUpdateRecord> => {
    let installedVersion: string | null = null;
    let selectedPath: string | null = null;
    try {
      const selected = await resolveCli({
        runtimeId: spec.runtimeId,
        binaryName: spec.binaryName,
        envOverride: spec.envOverride,
        extraEnvOverrides: spec.extraEnvOverrides,
      });
      selectedPath = selected.path;
      installedVersion = parseVersion(selected.version);
    } catch {
      // Missing or unprobeable CLIs do not prevent the rest of the report.
    }
    const latest = selectedPath ? await latestVersion(spec.release, refresh) : null;
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
    };
  }));
}
