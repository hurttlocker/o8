import 'server-only';

import { constants } from 'node:fs';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { parse } from 'smol-toml';

export type StableCli = 'codex' | 'claude-code' | 'grok';
export type CliInstallation = {
  manager: 'npm' | 'native' | 'homebrew' | 'manual';
  binary: string;
  root?: string;
  brew?: string;
  package?: 'codex' | 'claude-code' | 'claude-code@latest';
  packageKind?: 'cask' | 'formula';
  channel?: 'latest' | 'stable';
};

export async function requireUserOwned(items: string[]): Promise<void> {
  const uid = process.getuid?.();
  if (uid === undefined || uid === 0) throw new Error('Installation ownership cannot be verified.');
  for (const item of items) {
    const info = await stat(item);
    if (info.uid !== uid) throw new Error('Installation is not owned by this user.');
    await access(item, constants.W_OK);
  }
}

/** Classify the selected executable. A version-manager shim is never its provider's owner. */
export async function inspectCliInstallation(runtime: StableCli, selected: { path: string; source: string }): Promise<CliInstallation> {
  const binary = await realpath(selected.path).catch(() => selected.path);
  const manual: CliInstallation = { manager: 'manual', binary };
  if (process.platform === 'win32' || selected.source === 'env' || /[/\\](?:shims|\.volta[/\\]bin|\.proto[/\\]shims)[/\\]/.test(selected.path)) return manual;
  const packageName = runtime === 'codex' ? '@openai/codex' : runtime === 'claude-code' ? '@anthropic-ai/claude-code' : '@xai-official/grok';
  const packageSegment = path.join('lib', 'node_modules', packageName) + path.sep;
  const packageIndex = binary.lastIndexOf(path.sep + packageSegment);
  if (packageIndex >= 0) {
    const root = binary.slice(0, packageIndex);
    const packageRoot = path.join(root, 'lib/node_modules', packageName);
    try {
      const metadata = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
      const command = runtime === 'codex' ? 'codex' : runtime === 'claude-code' ? 'claude' : 'grok';
      const declared = typeof metadata.bin === 'string' ? metadata.bin : metadata.bin?.[command]
        ?? (runtime === 'codex' ? 'bin/codex.js' : 'cli.js');
      const entry = typeof declared === 'string' ? path.resolve(packageRoot, declared) : '';
      if (metadata.name !== packageName || !entry.startsWith(packageRoot + path.sep) || await realpath(entry) !== binary
        || await realpath(path.join(root, 'bin', command)) !== binary) return manual;
      await requireUserOwned([root, path.join(root, 'bin'), path.join(root, 'lib/node_modules'), packageRoot, binary]);
      return { manager: 'npm', binary, root };
    } catch { return manual; }
  }
  if (runtime === 'codex') {
    const launcher = path.join(homedir(), '.local/bin/codex');
    const root = path.join(process.env.CODEX_HOME?.trim() || path.join(homedir(), '.codex'), 'packages/standalone/releases');
    const packageRoot = path.dirname(path.dirname(binary));
    if (path.dirname(packageRoot) === root && await realpath(launcher).catch(() => '') === binary) {
      try {
        const metadata = JSON.parse(await readFile(path.join(packageRoot, 'codex-package.json'), 'utf8'));
        if (metadata.layoutVersion !== 1 || metadata.variant !== 'codex' || metadata.entrypoint !== 'bin/codex'
          || !/^\d+\.\d+\.\d+$/.test(metadata.version) || !/^(?:x86_64|aarch64)-(?:apple-darwin|unknown-linux-(?:gnu|musl))$/.test(metadata.target)
          || path.basename(packageRoot) !== `${metadata.version}-${metadata.target}` || binary !== path.join(packageRoot, 'bin/codex')) return manual;
        await requireUserOwned([path.dirname(selected.path), path.dirname(launcher), path.dirname(root), root, packageRoot, binary]);
        return { manager: 'native', binary, root };
      } catch { return manual; }
    }
  }
  if (runtime === 'claude-code') {
    const launcher = path.join(homedir(), '.local/bin/claude');
    const root = path.join(homedir(), '.local/share/claude/versions');
    if (path.dirname(binary) === root && /^\d+\.\d+\.\d+$/.test(path.basename(binary))
      && await realpath(launcher).catch(() => '') === binary) {
      try {
        await requireUserOwned([path.dirname(selected.path), path.dirname(launcher), path.dirname(root), root, binary]);
        let channel: 'stable' | 'latest' = 'latest';
        const config = path.join(process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(homedir(), '.claude'), 'settings.json');
        const settings = JSON.parse(await readFile(config, 'utf8').catch(() => '{}'));
        if (settings.autoUpdatesChannel === 'stable') channel = 'stable';
        const managedFile = process.platform === 'darwin' ? '/Library/Application Support/ClaudeCode/managed-settings.json'
          : '/etc/claude-code/managed-settings.json';
        const managed = JSON.parse(await readFile(managedFile, 'utf8').catch(() => '{}'));
        if (managed.autoUpdatesChannel === 'stable' || managed.autoUpdatesChannel === 'latest') channel = managed.autoUpdatesChannel;
        return { manager: 'native', binary, root, channel };
      } catch { return manual; }
    }
  }
  if (runtime === 'grok' && !process.env.GROK_CLI_BASE_URL && !process.env.GROK_INSTALLER
    && (!process.env.GROK_HOME || path.resolve(process.env.GROK_HOME) === path.join(homedir(), '.grok'))) {
    const root = path.join(homedir(), '.grok');
    const launcher = path.join(root, 'bin/grok');
    if (path.dirname(binary) === path.join(root, 'downloads')
      && /^grok-(?:macos|linux)-(?:x86_64|aarch64|arm64)$/.test(path.basename(binary))
      && await realpath(launcher).catch(() => '') === binary) {
      try {
        // Stable native distribution only. Custom channels and installers keep
        // their own updater; never substitute a different feed or change policy.
        if (process.env.GROK_CHANNEL && process.env.GROK_CHANNEL !== 'stable'
          || process.env.GROK_CONFIG || process.env.GROK_CONFIG_PATH) return manual;
        const files = ['/etc/grok/managed_config.toml', path.join(root, 'managed_config.toml'), path.join(root, 'config.toml'),
          path.join(root, 'requirements.toml'), '/etc/grok/requirements.toml'];
        let preferences: { channel?: unknown; installer?: unknown } = {};
        for (const file of files) {
          const content = await readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
          if (content) {
            const settings = parse(content);
            if ('version_overrides' in settings) return manual;
            preferences = { ...preferences, ...settings.cli as object };
          }
        }
        if (preferences.channel && preferences.channel !== 'stable'
          || preferences.installer && preferences.installer !== 'internal') return manual;
        await requireUserOwned([path.dirname(selected.path), root, path.dirname(launcher), path.dirname(binary), binary]);
        return { manager: 'native', binary, root };
      } catch { return manual; }
    }
  }
  const match = binary.match(/^(.*)\/(Caskroom|Cellar)\/(codex|claude-code(?:@latest)?)\/[^/]+\//);
  if (match && (runtime === 'codex' ? match[3] === 'codex' : runtime === 'claude-code' && match[3]?.startsWith('claude-code'))) {
    const root = match[1]!;
    const brew = path.join(root, 'bin/brew');
    try {
      const brewReal = await realpath(brew);
      if (brewReal !== brew && !brewReal.startsWith(path.join(root, 'Homebrew') + path.sep) && !brewReal.startsWith(path.join(root, 'Library/Homebrew') + path.sep)) return manual;
      await access(brew, constants.X_OK);
      await requireUserOwned([root, path.join(root, 'bin'), path.join(root, match[2]!), path.join(root, match[2]!, match[3]!), binary]);
      return { manager: 'homebrew', binary, root, brew, package: match[3] as CliInstallation['package'], packageKind: match[2] === 'Caskroom' ? 'cask' : 'formula' };
    } catch { return manual; }
  }
  return manual;
}
