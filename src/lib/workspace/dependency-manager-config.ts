import path from 'node:path';

export const RECIPE_CONFIG_NAMES = new Set([
  '.npmrc',
  '.pnpmfile.cjs',
  '.yarnrc',
  '.yarnrc.yml',
  'bunfig.toml',
  'package.json',
  'pnpm-workspace.yaml',
]);

export class DependencyAuthenticationUnsupportedError extends Error {
  readonly code = 'dependency_authentication_unsupported';

  constructor() {
    super('Credential-bearing package-manager configuration is unsupported for public dependency installs.');
    this.name = 'DependencyAuthenticationUnsupportedError';
  }
}

const NPM_STYLE_REDIRECT_KEYS = new Set([
  'cache',
  'global-bin-dir',
  'global-dir',
  'globalconfig',
  'lockfile-dir',
  'modules-dir',
  'prefix',
  'state-dir',
  'store-dir',
  'tmp',
  'userconfig',
  'virtual-store-dir',
]);

const YARN_CLASSIC_REDIRECT_KEYS = new Set([
  'cache-folder',
  'global-folder',
  'install-state-path',
  'link-folder',
  'modules-folder',
  'offline-cache-folder',
  'preferred-cache-folder',
  'virtual-folder',
  'yarn-offline-mirror',
  'yarn-path',
]);

const YARN_BERRY_REDIRECT_KEYS = new Set([
  'cachefolder',
  'globalfolder',
  'installstatepath',
  'patchfolder',
  'pnpdatapath',
  'virtualfolder',
]);

function normalizedConfigKey(value: string): string {
  return value.trim().replace(/^--?/, '').replaceAll('_', '-').toLowerCase();
}

function rejectRedirect(relativePath: string, key: string): never {
  throw new Error(`Dependency manager config cannot redirect managed output: ${relativePath}:${key}`);
}

function assertNpmStyleOutputControlled(relativePath: string, text: string): void {
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*[#;]/.test(line)) continue;
    const match = /^\s*([^=\s]+)\s*=/.exec(line);
    if (!match?.[1]) continue;
    const key = normalizedConfigKey(match[1]);
    if (NPM_STYLE_REDIRECT_KEYS.has(key)) rejectRedirect(relativePath, key);
  }
}

function assertYarnClassicOutputControlled(relativePath: string, text: string): void {
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const match = /^\s*"?(-{0,2}[A-Za-z0-9_.-]+)"?\s+/.exec(line);
    if (!match?.[1]) continue;
    const key = normalizedConfigKey(match[1]);
    if (YARN_CLASSIC_REDIRECT_KEYS.has(key)) rejectRedirect(relativePath, key);
  }
}

function assertYarnBerryOutputControlled(relativePath: string, text: string): void {
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const match = /^\s*(?:"([A-Za-z][A-Za-z0-9]*)"|'([A-Za-z][A-Za-z0-9]*)'|([A-Za-z][A-Za-z0-9]*))\s*:/.exec(line);
    const key = (match?.[1] ?? match?.[2] ?? match?.[3])?.toLowerCase();
    if (!key) continue;
    if (YARN_BERRY_REDIRECT_KEYS.has(key)) rejectRedirect(relativePath, key);
  }
}

function assertBunOutputControlled(relativePath: string, text: string): void {
  let section = '';
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const sectionMatch = /^\s*\[([^\]]+)]\s*(?:#.*)?$/.exec(line);
    if (sectionMatch?.[1]) {
      section = sectionMatch[1].replace(/["'\s]/g, '').toLowerCase();
      continue;
    }
    const keyMatch = /^\s*([^=]+?)\s*=/.exec(line);
    if (!keyMatch?.[1]) continue;
    const key = keyMatch[1].replace(/["'\s]/g, '').toLowerCase();
    const qualified = section ? `${section}.${key}` : key;
    if (qualified === 'install.cache.dir'
      || qualified === 'install.globaldir'
      || qualified === 'install.globalbindir'
      || qualified === 'install.lockfile.path'
      || qualified === 'install.cache-dir'
      || qualified === 'install.global-dir'
      || qualified === 'install.global-bin-dir') {
      rejectRedirect(relativePath, qualified);
    }
  }
}

export function assertSafeDependencyManagerConfig(relativePath: string, bytes: Buffer): void {
  if (!RECIPE_CONFIG_NAMES.has(relativePath) || relativePath === 'package.json') return;
  const text = bytes.toString('utf8');
  const bindsEnvironment = /\$\{[^}]+\}|\bprocess\.env\b/.test(text);
  const declaresCredential = relativePath === '.npmrc'
    ? /^\s*(?:\/\/[^:]+\/:)?(?:_authToken|_auth|username|_password)\s*=/im.test(text)
    : relativePath === '.yarnrc' || relativePath === '.yarnrc.yml'
      ? /^\s*(?:npmAuthToken|npmAuthIdent)\s*:/im.test(text)
      : relativePath === 'bunfig.toml'
        ? /^\s*(?:token|username|password)\s*=/im.test(text)
        : false;
  if (bindsEnvironment || declaresCredential) {
    throw new DependencyAuthenticationUnsupportedError();
  }
  if (relativePath === '.npmrc') assertNpmStyleOutputControlled(relativePath, text);
  if (relativePath === '.yarnrc') assertYarnClassicOutputControlled(relativePath, text);
  if (relativePath === '.yarnrc.yml') assertYarnBerryOutputControlled(relativePath, text);
  if (relativePath === 'bunfig.toml') assertBunOutputControlled(relativePath, text);
}

export function yarnExecutionTargets(bytes: Buffer): string[] {
  const targets: string[] = [];
  for (const line of bytes.toString('utf8').split(/\r?\n/)) {
    const match = /^\s*(?:yarnPath|(?:-\s*)?path):\s*([^#]+?)\s*$/.exec(line);
    if (!match?.[1]) continue;
    const target = match[1].trim().replace(/^(?:"([^"]+)"|'([^']+)')$/, '$1$2');
    if (!target || target.includes('${')) {
      throw new Error('Yarn executable config target is dynamic or empty.');
    }
    targets.push(target.replace(/^\.\//, ''));
  }
  return [...new Set(targets)].sort();
}

export function assertContainedConfigTarget(workspacePath: string, target: string): string {
  const normalized = target.trim().replaceAll('\\', '/').replace(/^\.\//, '');
  const absolute = path.resolve(workspacePath, normalized);
  const relative = path.relative(workspacePath, absolute);
  if (!normalized
    || path.posix.isAbsolute(normalized)
    || relative.startsWith('..')
    || path.isAbsolute(relative)) {
    throw new Error(`Dependency recipe path is unsafe: ${JSON.stringify(target)}`);
  }
  return normalized;
}
