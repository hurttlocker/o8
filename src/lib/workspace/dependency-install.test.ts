import { execFileSync } from 'node:child_process';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  auditPrivateDependencyView,
  DependencyAuthenticationUnsupportedError,
  detectDependencyInstallCommand,
  deriveDependencyInstallRecipe,
  runDependencyInstall,
  type SupportedPackageManager,
} from './dependency-install';

const roots: string[] = [];
const versions: Record<SupportedPackageManager, string> = {
  npm: '11.8.0',
  pnpm: '10.6.5',
  yarn: '1.22.17',
  bun: '1.2.5',
};
const lockfiles: Record<SupportedPackageManager, string> = {
  npm: 'package-lock.json',
  pnpm: 'pnpm-lock.yaml',
  yarn: 'yarn.lock',
  bun: 'bun.lock',
};
const commands: Record<SupportedPackageManager, string> = {
  npm: 'npm ci --prefer-offline',
  pnpm: 'pnpm install --frozen-lockfile',
  yarn: 'yarn install --immutable',
  bun: 'bun install --frozen-lockfile',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function commitAll(cwd: string, message: string): void {
  git(cwd, 'add', '-A');
  git(cwd, '-c', 'user.name=o8-test', '-c', 'user.email=test@invalid', 'commit', '-qm', message);
}

function fixture(manager: SupportedPackageManager, includeVersion = true): string {
  const root = mkdtempSync(path.join(os.tmpdir(), `o8-dependency-${manager}-`));
  roots.push(root);
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: `fixture-${manager}`,
    version: '1.0.0',
    packageManager: includeVersion ? `${manager}@${versions[manager]}` : manager,
  }));
  writeFileSync(path.join(root, lockfiles[manager]), `${manager}-lock-v1\n`);
  git(root, 'init', '-q');
  git(root, 'add', '.');
  git(root, '-c', 'user.name=o8-test', '-c', 'user.email=test@invalid', 'commit', '-qm', 'fixture');
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('package-manager-native dependency install contract', { timeout: 30_000 }, () => {
  it.each(Object.keys(versions) as SupportedPackageManager[])(
    'uses the %s native cache while producing a private writable view',
    async (manager) => {
      const workspace = fixture(manager);
      const secret = `credential-${manager}-must-not-enter-recipe`;
      process.env.O8_TEST_INSTALL_CREDENTIAL = secret;
      process.env.NPM_TOKEN = secret;
      process.env.npm_config_registry = 'https://credential.invalid/';
      process.env.NODE_OPTIONS = '--trace-warnings';
      let invocationJson = '';
      try {
        const receipt = await runDependencyInstall(workspace, commands[manager], {
          cacheRoot: path.join(workspace, '.test-native-cache'),
          resolveVersion: async () => versions[manager],
          run: async (invocation) => {
            invocationJson = JSON.stringify({
              command: invocation.command,
              args: invocation.args,
              cache: manager === 'npm'
                ? invocation.env.npm_config_cache
                : manager === 'yarn'
                  ? invocation.env.YARN_GLOBAL_FOLDER
                  : manager === 'bun'
                    ? invocation.env.BUN_INSTALL_CACHE_DIR
                    : invocation.args[invocation.args.indexOf('--store-dir') + 1],
              env: invocation.env,
            });
            mkdirSync(path.join(workspace, 'node_modules', 'fixture'), { recursive: true });
            writeFileSync(path.join(workspace, 'node_modules', 'fixture', 'index.js'), 'private\n');
          },
        });

        expect(receipt.recipe.packageManager).toBe(manager);
        expect(receipt.recipe.packageManagerVersion).toBe(versions[manager]);
        expect(receipt.privateViewVerified).toBe(true);
        expect(invocationJson).toContain('.test-native-cache');
        expect(invocationJson).not.toContain(secret);
        expect(invocationJson).not.toContain('credential.invalid');
        expect(invocationJson).not.toContain('NODE_OPTIONS');
        expect(JSON.stringify(receipt)).not.toContain(secret);
        expect(receipt.recipe.cacheAuthorityId).toBe(
          `native-download-cache:${manager}:recipe:${receipt.recipe.key}`,
        );
      } finally {
        delete process.env.O8_TEST_INSTALL_CREDENTIAL;
        delete process.env.NPM_TOKEN;
        delete process.env.npm_config_registry;
        delete process.env.NODE_OPTIONS;
      }
    },
  );

  it('invalidates on one-byte lock drift, manager drift, and runtime ABI drift', async () => {
    const workspace = fixture('npm', false);
    const resolveVersion = async () => versions.npm;
    const baseline = await deriveDependencyInstallRecipe(workspace, commands.npm, {
      resolveVersion,
      runtimeFacts: { abi: '127', platform: 'darwin', architecture: 'arm64' },
    });

    writeFileSync(path.join(workspace, 'package-lock.json'), 'npm-lock-v2\n');
    commitAll(workspace, 'lock drift');
    const lockDrift = await deriveDependencyInstallRecipe(workspace, commands.npm, {
      resolveVersion,
      runtimeFacts: { abi: '127', platform: 'darwin', architecture: 'arm64' },
    });
    expect(lockDrift.key).not.toBe(baseline.key);

    const managerDrift = await deriveDependencyInstallRecipe(workspace, commands.npm, {
      resolveVersion: async () => '11.9.0',
      runtimeFacts: { abi: '127', platform: 'darwin', architecture: 'arm64' },
    });
    expect(managerDrift.key).not.toBe(lockDrift.key);

    const abiDrift = await deriveDependencyInstallRecipe(workspace, commands.npm, {
      resolveVersion: async () => '11.9.0',
      runtimeFacts: { abi: '128', platform: 'darwin', architecture: 'arm64' },
    });
    expect(abiDrift.key).not.toBe(managerDrift.key);
  });

  it('accepts an integrity-qualified Corepack declaration and rejects version drift', async () => {
    const workspace = fixture('pnpm', false);
    writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({
      name: 'corepack-integrity',
      version: '1.0.0',
      packageManager: `pnpm@${versions.pnpm}+sha512.${'a'.repeat(128)}`,
    }));
    commitAll(workspace, 'integrity-qualified manager');

    await expect(deriveDependencyInstallRecipe(workspace, commands.pnpm, {
      resolveVersion: async () => versions.pnpm,
    })).resolves.toMatchObject({ packageManagerVersion: versions.pnpm });
    await expect(deriveDependencyInstallRecipe(workspace, commands.pnpm, {
      resolveVersion: async () => '10.6.6',
    })).rejects.toThrow(/does not match/);
  });

  it('selects deterministic Yarn flags from the declared major version', async () => {
    const classic = fixture('yarn', false);
    writeFileSync(path.join(classic, 'package.json'), JSON.stringify({
      name: 'yarn-classic',
      version: '1.0.0',
      packageManager: 'yarn@1.22.22',
    }));
    commitAll(classic, 'Yarn Classic declaration');
    await expect(detectDependencyInstallCommand(classic)).resolves.toBe(
      'yarn install --frozen-lockfile',
    );

    const berry = fixture('yarn', false);
    writeFileSync(path.join(berry, 'package.json'), JSON.stringify({
      name: 'yarn-berry',
      version: '1.0.0',
      packageManager: `yarn@4.6.0+sha512.${'b'.repeat(128)}`,
    }));
    commitAll(berry, 'Yarn Berry declaration');
    await expect(detectDependencyInstallCommand(berry)).resolves.toBe(
      'yarn install --immutable',
    );
  });

  it('keys executable manager config and refuses untracked Yarn targets', async () => {
    const pnpmWorkspace = fixture('pnpm', false);
    writeFileSync(path.join(pnpmWorkspace, '.pnpmfile.cjs'), 'module.exports = { hooks: {} };\n');
    commitAll(pnpmWorkspace, 'pnpm executable config');
    const pnpmBaseline = await deriveDependencyInstallRecipe(
      pnpmWorkspace,
      `${commands.pnpm} --ignore-scripts`,
      { resolveVersion: async () => versions.pnpm },
    );
    writeFileSync(path.join(pnpmWorkspace, '.pnpmfile.cjs'), 'module.exports = { hooks: { readPackage() {} } };\n');
    commitAll(pnpmWorkspace, 'pnpm executable config drift');
    const pnpmDrift = await deriveDependencyInstallRecipe(
      pnpmWorkspace,
      `${commands.pnpm} --ignore-scripts`,
      { resolveVersion: async () => versions.pnpm },
    );
    expect(pnpmDrift.key).not.toBe(pnpmBaseline.key);

    const yarnWorkspace = fixture('yarn', false);
    mkdirSync(path.join(yarnWorkspace, '.yarn', 'releases'), { recursive: true });
    mkdirSync(path.join(yarnWorkspace, '.yarn', 'plugins'), { recursive: true });
    writeFileSync(path.join(yarnWorkspace, '.yarnrc.yml'), [
      'yarnPath: .yarn/releases/yarn.cjs',
      'plugins:',
      '  - path: .yarn/plugins/install-plugin.cjs',
      '    spec: install-plugin',
      '',
    ].join('\n'));
    writeFileSync(path.join(yarnWorkspace, '.yarn', 'releases', 'yarn.cjs'), 'release-v1\n');
    writeFileSync(path.join(yarnWorkspace, '.yarn', 'plugins', 'install-plugin.cjs'), 'plugin-v1\n');
    commitAll(yarnWorkspace, 'yarn executable config');
    const yarnRecipe = await deriveDependencyInstallRecipe(
      yarnWorkspace,
      `${commands.yarn} --ignore-scripts`,
      { resolveVersion: async () => versions.yarn },
    );
    expect(yarnRecipe.inputDigests.map((entry) => entry.path)).toEqual(expect.arrayContaining([
      '.yarn/releases/yarn.cjs',
      '.yarn/plugins/install-plugin.cjs',
    ]));
    writeFileSync(path.join(yarnWorkspace, '.yarnrc.yml'), 'yarnPath: ../external/yarn.cjs\n');
    commitAll(yarnWorkspace, 'unsafe yarn target');
    await expect(deriveDependencyInstallRecipe(
      yarnWorkspace,
      `${commands.yarn} --ignore-scripts`,
      { resolveVersion: async () => versions.yarn },
    )).rejects.toThrow(/unsafe/);
  });

  it('binds enabled lifecycle scripts to the committed tree and refuses tracked dirt', async () => {
    const workspace = fixture('npm', false);
    mkdirSync(path.join(workspace, 'scripts'));
    writeFileSync(path.join(workspace, 'scripts', 'postinstall.mjs'), 'console.log("v1");\n');
    writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({
      name: 'lifecycle-tree',
      version: '1.0.0',
      packageManager: 'npm',
      scripts: { postinstall: 'node scripts/postinstall.mjs' },
    }));
    commitAll(workspace, 'lifecycle input');
    const baseline = await deriveDependencyInstallRecipe(workspace, commands.npm, {
      resolveVersion: async () => versions.npm,
    });
    symlinkSync('scripts/postinstall.mjs', path.join(workspace, 'tracked-script-link'));
    commitAll(workspace, 'tracked lifecycle symlink');
    await expect(deriveDependencyInstallRecipe(workspace, commands.npm, {
      resolveVersion: async () => versions.npm,
    })).resolves.toMatchObject({ packageManager: 'npm' });
    writeFileSync(path.join(workspace, 'scripts', 'postinstall.mjs'), 'console.log("v2");\n');
    await expect(deriveDependencyInstallRecipe(workspace, commands.npm, {
      resolveVersion: async () => versions.npm,
    })).rejects.toThrow(/clean committed Git tree/);
    commitAll(workspace, 'lifecycle input drift');
    const drift = await deriveDependencyInstallRecipe(workspace, commands.npm, {
      resolveVersion: async () => versions.npm,
    });
    expect(drift.gitTreeSha).not.toBe(baseline.gitTreeSha);
    expect(drift.key).not.toBe(baseline.key);
  });

  it('keys patches, workspace manifests, and local dependency identity without raw bytes', async () => {
    const workspace = fixture('pnpm', false);
    mkdirSync(path.join(workspace, 'packages', 'local'), { recursive: true });
    mkdirSync(path.join(workspace, 'patches'));
    writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({
      name: 'root',
      version: '1.0.0',
      packageManager: 'pnpm',
      dependencies: { local: 'file:./packages/local' },
    }));
    writeFileSync(path.join(workspace, 'packages', 'local', 'package.json'), JSON.stringify({
      name: 'local',
      version: '1.0.0',
    }));
    writeFileSync(path.join(workspace, 'packages', 'local', 'index.js'), 'local-private-source\n');
    symlinkSync('index.js', path.join(workspace, 'packages', 'local', 'index-link.js'));
    writeFileSync(path.join(workspace, 'patches', 'fixture.patch'), 'patch-private-bytes\n');
    commitAll(workspace, 'local inputs');
    const recipe = await deriveDependencyInstallRecipe(workspace, commands.pnpm, {
      resolveVersion: async () => versions.pnpm,
    });

    expect(recipe.inputDigests.map((entry) => entry.path)).toContain('patches/fixture.patch');
    expect(recipe.inputDigests.map((entry) => entry.path)).toContain('packages/local/package.json');
    expect(recipe.localDependencyDigests).toHaveLength(1);
    expect(JSON.stringify(recipe)).not.toContain('local-private-source');
    expect(JSON.stringify(recipe)).not.toContain('patch-private-bytes');
  });

  it('keys a contained local gitlink and refuses an escaping local symlink', async () => {
    const workspace = fixture('npm', false);
    const gitlink = path.join(workspace, 'packages', 'gitlink');
    mkdirSync(gitlink, { recursive: true });
    git(gitlink, 'init', '-q');
    writeFileSync(path.join(gitlink, 'package.json'), JSON.stringify({
      name: 'local-gitlink',
      version: '1.0.0',
    }));
    git(gitlink, 'add', 'package.json');
    git(gitlink, '-c', 'user.name=o8-test', '-c', 'user.email=test@invalid', 'commit', '-qm', 'gitlink');
    writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({
      name: 'local-identity-root',
      version: '1.0.0',
      packageManager: 'npm',
      dependencies: { localGitlink: 'file:./packages/gitlink' },
    }));
    commitAll(workspace, 'local gitlink identity');
    const gitlinkRecipe = await deriveDependencyInstallRecipe(workspace, commands.npm, {
      resolveVersion: async () => versions.npm,
    });
    expect(gitlinkRecipe.localDependencyDigests).toHaveLength(1);

    const localPackage = path.join(workspace, 'packages', 'local');
    mkdirSync(localPackage, { recursive: true });
    writeFileSync(path.join(localPackage, 'package.json'), JSON.stringify({
      name: 'local-package',
      version: '1.0.0',
    }));
    const external = path.join(path.dirname(workspace), `${path.basename(workspace)}-outside-link`);
    roots.push(external);
    mkdirSync(external);
    writeFileSync(path.join(external, 'target.js'), 'outside\n');
    symlinkSync(
      path.relative(localPackage, path.join(external, 'target.js')),
      path.join(localPackage, 'escape.js'),
    );
    writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({
      name: 'local-identity-root',
      version: '1.0.0',
      packageManager: 'npm',
      dependencies: { localPackage: 'file:./packages/local' },
    }));
    commitAll(workspace, 'escaping local symlink');
    await expect(deriveDependencyInstallRecipe(workspace, commands.npm, {
      resolveVersion: async () => versions.npm,
    })).rejects.toThrow(/symlink escapes/);
  });

  it('fails closed on a conflicting lockfile and a local dependency outside the workspace', async () => {
    const workspace = fixture('npm', false);
    writeFileSync(path.join(workspace, 'pnpm-lock.yaml'), 'conflict\n');
    commitAll(workspace, 'conflicting lock');
    await expect(deriveDependencyInstallRecipe(workspace, commands.npm, {
      resolveVersion: async () => versions.npm,
    })).rejects.toThrow(/conflicts with another tracked lockfile/);

    const external = path.join(path.dirname(workspace), `${path.basename(workspace)}-external`);
    mkdirSync(external);
    roots.push(external);
    writeFileSync(path.join(external, 'package.json'), '{"name":"external","version":"1.0.0"}');
    writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({
      name: 'root',
      version: '1.0.0',
      packageManager: 'npm',
      dependencies: { external: `file:../${path.basename(external)}` },
    }));
    git(workspace, 'rm', '-q', '-f', 'pnpm-lock.yaml');
    commitAll(workspace, 'external dependency');
    await expect(deriveDependencyInstallRecipe(workspace, commands.npm, {
      resolveVersion: async () => versions.npm,
    })).rejects.toThrow(/escapes its workspace/);
  });

  it('refuses external links and shared hardlinks in an installed view', async () => {
    const workspace = fixture('npm');
    const external = path.join(path.dirname(workspace), `${path.basename(workspace)}-outside`);
    roots.push(external);
    mkdirSync(external);
    writeFileSync(path.join(external, 'shared.js'), 'shared\n');
    mkdirSync(path.join(workspace, 'node_modules', 'fixture'), { recursive: true });
    symlinkSync(external, path.join(workspace, 'node_modules', 'external'));
    await expect(auditPrivateDependencyView(workspace)).rejects.toThrow(/escapes/);

    rmSync(path.join(workspace, 'node_modules', 'external'));
    linkSync(
      path.join(external, 'shared.js'),
      path.join(workspace, 'node_modules', 'fixture', 'shared.js'),
    );
    await expect(auditPrivateDependencyView(workspace)).rejects.toThrow(/shared hardlink/);
  });

  it.each([
    ['positional package', 'npm ci left-pad'],
    ['prefix override', 'npm ci --prefix ../outside'],
    ['directory override', 'pnpm install --dir=../outside'],
    ['config override', 'yarn install --use-yarnrc ../outside/.yarnrc'],
    ['ambiguous short flag', 'bun install -g'],
    ['shell syntax', 'npm ci && touch ../outside'],
  ])('refuses %s before any install child or filesystem side effect', async (_label, command) => {
    const manager = command.split(/\s+/, 1)[0] as SupportedPackageManager;
    const workspace = fixture(manager);
    const outside = path.join(path.dirname(workspace), `${path.basename(workspace)}-side-effect`);
    let runCount = 0;

    await expect(runDependencyInstall(workspace, command, {
      cacheRoot: path.join(workspace, '.cache-authority'),
      resolveVersion: async () => versions[manager],
      run: async () => { runCount += 1; },
    })).rejects.toThrow(/unsupported|shell syntax/);

    expect(runCount).toBe(0);
    expect(existsSync(outside)).toBe(false);
    expect(existsSync(path.join(workspace, 'node_modules'))).toBe(false);
    expect(existsSync(path.join(workspace, '.cache-authority'))).toBe(false);
  });

  it('returns a structured credential refusal before cache or install effects', async () => {
    const workspace = fixture('npm');
    writeFileSync(
      path.join(workspace, '.npmrc'),
      '//registry.invalid/:_authToken=${NPM_TOKEN}\n',
    );
    commitAll(workspace, 'credential binding');
    const cacheRoot = path.join(workspace, '.credential-cache');
    let runCount = 0;

    const error = await runDependencyInstall(workspace, commands.npm, {
      cacheRoot,
      resolveVersion: async () => versions.npm,
      run: async () => { runCount += 1; },
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(DependencyAuthenticationUnsupportedError);
    expect(error).toMatchObject({ code: 'dependency_authentication_unsupported' });
    expect(runCount).toBe(0);
    expect(existsSync(cacheRoot)).toBe(false);
    expect(existsSync(path.join(workspace, '.o8-install-runtime'))).toBe(false);
  });

  it.each([
    ['npm', '.npmrc', 'cache=../outside/npm-cache\n'],
    ['pnpm', '.npmrc', 'virtual-store-dir=../outside/.pnpm\n'],
    ['pnpm', '.npmrc', 'store-dir=../outside/pnpm-store\n'],
    ['yarn', '.yarnrc', '--modules-folder "../outside/node_modules"\n'],
    ['yarn', '.yarnrc', 'yarn-path "../outside/yarn.js"\n'],
    ['yarn', '.yarnrc.yml', 'cacheFolder: ../outside/yarn-cache\n'],
    ['yarn', '.yarnrc.yml', '"virtualFolder": ../outside/yarn-virtual\n'],
    ['bun', 'bunfig.toml', '[install.cache]\ndir = "../outside/bun-cache"\n'],
    ['bun', 'bunfig.toml', '["install"."cache"]\n"dir" = "../outside/bun-cache"\n'],
  ] as const)(
    'refuses a tracked %s %s output redirect before cache, runtime, child, or outside writes',
    async (manager, configName, config) => {
      const workspace = fixture(manager);
      const outside = path.join(
        path.dirname(workspace),
        `${path.basename(workspace)}-outside-config`,
      );
      roots.push(outside);
      writeFileSync(
        path.join(workspace, configName),
        config.replaceAll('../outside', `../${path.basename(outside)}`),
      );
      commitAll(workspace, `${manager} output redirect`);
      const cacheRoot = path.join(workspace, '.redirect-cache');
      let runCount = 0;

      await expect(runDependencyInstall(workspace, commands[manager], {
        cacheRoot,
        resolveVersion: async () => versions[manager],
        run: async () => { runCount += 1; },
      })).rejects.toThrow(/cannot redirect managed output/);

      expect(runCount).toBe(0);
      expect(existsSync(outside)).toBe(false);
      expect(existsSync(cacheRoot)).toBe(false);
      expect(existsSync(path.join(workspace, '.o8-install-runtime'))).toBe(false);
      expect(existsSync(path.join(workspace, 'node_modules'))).toBe(false);
    },
  );

  it.each(['npm', 'bun'] as const)(
    'does not auto-detect an unexecutable no-lock %s install contract',
    async (manager) => {
      const workspace = fixture(manager);
      git(workspace, 'rm', '-q', lockfiles[manager]);
      commitAll(workspace, `${manager} no-lock contract`);

      await expect(detectDependencyInstallCommand(workspace)).resolves.toBeNull();
    },
  );

  it('isolates writable native caches by exact recipe key', async () => {
    const workspace = fixture('npm', false);
    const cachePaths: string[] = [];
    const run = async (invocation: { env: NodeJS.ProcessEnv }) => {
      cachePaths.push(invocation.env.npm_config_cache!);
      mkdirSync(path.join(workspace, 'node_modules', 'fixture'), { recursive: true });
      writeFileSync(path.join(workspace, 'node_modules', 'fixture', 'index.js'), 'private\n');
    };
    const first = await runDependencyInstall(workspace, commands.npm, {
      cacheRoot: path.join(workspace, '.recipe-caches'),
      resolveVersion: async () => versions.npm,
      run,
    });
    rmSync(path.join(workspace, 'node_modules'), { recursive: true, force: true });
    writeFileSync(path.join(workspace, 'package-lock.json'), 'npm-lock-v2\n');
    commitAll(workspace, 'cache recipe drift');
    const second = await runDependencyInstall(workspace, commands.npm, {
      cacheRoot: path.join(workspace, '.recipe-caches'),
      resolveVersion: async () => versions.npm,
      run,
    });

    expect(second.recipe.key).not.toBe(first.recipe.key);
    expect(cachePaths[1]).not.toBe(cachePaths[0]);
    expect(cachePaths[0]).toContain(first.recipe.key);
    expect(cachePaths[1]).toContain(second.recipe.key);
  });

  it('shares only the native cache across concurrent installs of one recipe', async () => {
    const firstWorkspace = fixture('npm');
    const secondWorkspace = fixture('npm');
    const cacheRoot = path.join(path.dirname(firstWorkspace), 'shared-recipe-cache');
    roots.push(cacheRoot);
    const invocations: Array<{ label: string; env: NodeJS.ProcessEnv; runtimeRoot: string }> = [];
    let releaseBoth!: () => void;
    const bothStarted = new Promise<void>((resolve) => { releaseBoth = resolve; });
    const run = (label: string, workspace: string) => async (invocation: { env: NodeJS.ProcessEnv }) => {
      const runtimeRoot = path.dirname(invocation.env.HOME!);
      invocations.push({ label, env: invocation.env, runtimeRoot });
      for (const directory of [
        invocation.env.HOME!,
        invocation.env.XDG_CONFIG_HOME!,
        invocation.env.XDG_CACHE_HOME!,
        invocation.env.COREPACK_HOME!,
        invocation.env.TMPDIR!,
      ]) {
        writeFileSync(path.join(directory, 'install-state'), label);
      }
      if (invocations.length === 2) releaseBoth();
      await bothStarted;
      for (const directory of [
        invocation.env.HOME!,
        invocation.env.XDG_CONFIG_HOME!,
        invocation.env.XDG_CACHE_HOME!,
        invocation.env.COREPACK_HOME!,
        invocation.env.TMPDIR!,
      ]) {
        expect(readFileSync(path.join(directory, 'install-state'), 'utf8')).toBe(label);
      }
      mkdirSync(path.join(workspace, 'node_modules', 'fixture'), { recursive: true });
      writeFileSync(path.join(workspace, 'node_modules', 'fixture', 'index.js'), 'private\n');
    };

    const [first, second] = await Promise.all([
      runDependencyInstall(firstWorkspace, commands.npm, {
        cacheRoot,
        resolveVersion: async () => versions.npm,
        run: run('first', firstWorkspace),
      }),
      runDependencyInstall(secondWorkspace, commands.npm, {
        cacheRoot,
        resolveVersion: async () => versions.npm,
        run: run('second', secondWorkspace),
      }),
    ]);

    expect(first.recipe.key).toBe(second.recipe.key);
    expect(invocations[0]?.env.npm_config_cache).toBe(invocations[1]?.env.npm_config_cache);
    for (const name of ['HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'COREPACK_HOME', 'TMPDIR'] as const) {
      expect(invocations[0]?.env[name]).not.toBe(invocations[1]?.env[name]);
    }
    expect(invocations.every((entry) => !existsSync(entry.runtimeRoot))).toBe(true);
  });

  it('refuses a swapped runtime namespace without deleting the replacement', async () => {
    const workspace = fixture('npm');
    let replacementRoot = '';
    let movedRoot = '';

    await expect(runDependencyInstall(workspace, commands.npm, {
      cacheRoot: path.join(workspace, '.recipe-cache'),
      resolveVersion: async () => versions.npm,
      run: async () => {
        mkdirSync(path.join(workspace, 'node_modules', 'fixture'), { recursive: true });
        writeFileSync(path.join(workspace, 'node_modules', 'fixture', 'index.js'), 'private\n');
      },
      afterRuntimeTreeCapture: async (runtimeRoot) => {
        replacementRoot = runtimeRoot;
        movedRoot = `${runtimeRoot}-moved`;
        renameSync(runtimeRoot, movedRoot);
        mkdirSync(runtimeRoot, { mode: 0o700 });
        writeFileSync(path.join(runtimeRoot, 'unrelated.txt'), 'preserve replacement\n');
      },
    })).rejects.toThrow(/identity|unexpected directory/);

    expect(readFileSync(path.join(replacementRoot, 'unrelated.txt'), 'utf8')).toBe(
      'preserve replacement\n',
    );
    expect(existsSync(movedRoot)).toBe(true);
  });
});
