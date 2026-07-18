'use strict';

const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');

const redirects = new Map();
let resolverInstalled = false;

function assertSupportedArchitecture(packageName, arch) {
  if (arch !== 'x64' && arch !== 'arm64') {
    throw new Error(`[native-addon] Unsupported macOS architecture for ${packageName}: ${arch}`);
  }
}

function bundledAbiDirectories(moduleRoot) {
  try {
    return fs.readdirSync(path.join(moduleRoot, 'prebuilds'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^node-v\d+$/.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function selectPrebuild(moduleRoot, packageName, addonName, arch, abi, pathExists = fs.existsSync) {
  assertSupportedArchitecture(packageName, arch);

  const abiDirectories = bundledAbiDirectories(moduleRoot);
  const selectedAbiDirectory = `node-v${abi}`;
  const selected = path.join(moduleRoot, 'prebuilds', selectedAbiDirectory, `darwin-${arch}`, addonName);
  if (pathExists(selected)) return selected;

  // Older single-ABI bundles only have prebuilds/darwin-<arch>. A partially
  // migrated bundle may have one node-v* directory. Preserve both layouts,
  // but never silently choose an arbitrary ABI when multiple are bundled.
  if (abiDirectories.length === 1) {
    const singleAbi = path.join(moduleRoot, 'prebuilds', abiDirectories[0], `darwin-${arch}`, addonName);
    if (pathExists(singleAbi)) return singleAbi;
  }
  if (abiDirectories.length === 0) {
    const legacy = path.join(moduleRoot, 'prebuilds', `darwin-${arch}`, addonName);
    if (pathExists(legacy)) return legacy;
  }

  throw new Error(`[native-addon] Missing ${packageName} ${arch} prebuild for Node ABI ${abi}: ${selected}`);
}

function selectBetterSqlite3Prebuild(
  moduleRoot,
  arch,
  pathExists = fs.existsSync,
  abi = process.versions.modules,
) {
  return selectPrebuild(moduleRoot, 'better-sqlite3', 'better_sqlite3.node', arch, abi, pathExists);
}

function selectNodePtyPrebuild(
  moduleRoot,
  arch,
  pathExists = fs.existsSync,
  abi = process.versions.modules,
) {
  return selectPrebuild(moduleRoot, 'node-pty', 'pty.node', arch, abi, pathExists);
}

function installReadOnlyFallback() {
  if (resolverInstalled) return;
  resolverInstalled = true;

  const originalResolveFilename = Module._resolveFilename;
  Module._resolveFilename = function resolvePackagedNativeAddon(request, parent, isMain, options) {
    if (typeof request === 'string') {
      const redirect = redirects.get(path.resolve(request));
      if (redirect) return redirect;
    }
    return originalResolveFilename.call(this, request, parent, isMain, options);
  };
}

function findPackageRoots(serverRoot, packageName) {
  const nodeModules = path.join(serverRoot, 'node_modules');
  let entries;
  try {
    entries = fs.readdirSync(nodeModules, { withFileTypes: true });
  } catch (error) {
    throw new Error(`[native-addon] Cannot inspect packaged node_modules at ${nodeModules}: ${error.message}`);
  }

  return entries
    .filter((entry) => entry.isDirectory() && (entry.name === packageName || entry.name.startsWith(`${packageName}-`)))
    .map((entry) => path.join(nodeModules, entry.name));
}

function prepareBetterSqlite3(serverRoot, arch = process.arch, abi = process.versions.modules) {
  const moduleRoots = findPackageRoots(serverRoot, 'better-sqlite3');
  if (moduleRoots.length === 0) {
    throw new Error(`[native-addon] No packaged better-sqlite3 module found under ${serverRoot}`);
  }

  for (const moduleRoot of moduleRoots) {
    const source = selectBetterSqlite3Prebuild(moduleRoot, arch, fs.existsSync, abi);
    const target = path.join(moduleRoot, 'build', 'Release', 'better_sqlite3.node');
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
    } catch (error) {
      redirects.set(path.resolve(target), source);
      installReadOnlyFallback();
      console.warn(`[native-addon] ${target} is not writable; loading the ${arch} ABI ${abi} prebuild directly (${error.code || error.message})`);
    }
  }
}

function prepareNodePty(serverRoot, arch = process.arch, abi = process.versions.modules) {
  const moduleRoots = findPackageRoots(serverRoot, 'node-pty');
  if (moduleRoots.length === 0) {
    throw new Error(`[native-addon] No packaged node-pty module found under ${serverRoot}`);
  }

  for (const moduleRoot of moduleRoots) {
    const source = selectNodePtyPrebuild(moduleRoot, arch, fs.existsSync, abi);
    const sourceHelper = path.join(path.dirname(source), 'spawn-helper');
    const targetDir = path.join(moduleRoot, 'build', 'Release');
    try {
      fs.mkdirSync(targetDir, { recursive: true });
      fs.copyFileSync(sourceHelper, path.join(targetDir, 'spawn-helper'));
      fs.chmodSync(path.join(targetDir, 'spawn-helper'), 0o755);
      fs.copyFileSync(source, path.join(targetDir, 'pty.node'));
    } catch (error) {
      // node-pty's published Darwin prebuild is Node-API compatible across 22
      // and 24. Its loader will reject a wrong-arch build/Release binary and
      // then use the existing prebuilds/darwin-<arch> package fallback.
      console.warn(`[native-addon] ${targetDir} is not writable; node-pty will use its ${arch} Node-API prebuild (${error.code || error.message})`);
    }
  }
}

function prepareNativeAddons(serverRoot, arch = process.arch, abi = process.versions.modules) {
  prepareBetterSqlite3(serverRoot, arch, abi);
  prepareNodePty(serverRoot, arch, abi);
}

module.exports = {
  prepareBetterSqlite3,
  prepareNativeAddons,
  prepareNodePty,
  selectBetterSqlite3Prebuild,
  selectNodePtyPrebuild,
};
