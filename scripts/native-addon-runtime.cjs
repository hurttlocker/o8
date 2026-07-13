'use strict';

const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');

const addonName = 'better_sqlite3.node';
const redirects = new Map();
let resolverInstalled = false;

function selectBetterSqlite3Prebuild(moduleRoot, arch, pathExists = fs.existsSync) {
  if (arch !== 'x64' && arch !== 'arm64') {
    throw new Error(`[native-addon] Unsupported macOS architecture for better-sqlite3: ${arch}`);
  }

  const source = path.join(moduleRoot, 'prebuilds', `darwin-${arch}`, addonName);
  if (!pathExists(source)) {
    throw new Error(`[native-addon] Missing better-sqlite3 ${arch} prebuild: ${source}`);
  }
  return source;
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

function findBetterSqlite3Roots(serverRoot) {
  const nodeModules = path.join(serverRoot, 'node_modules');
  let entries;
  try {
    entries = fs.readdirSync(nodeModules, { withFileTypes: true });
  } catch (error) {
    throw new Error(`[native-addon] Cannot inspect packaged node_modules at ${nodeModules}: ${error.message}`);
  }

  return entries
    .filter((entry) => entry.isDirectory() && (entry.name === 'better-sqlite3' || entry.name.startsWith('better-sqlite3-')))
    .map((entry) => path.join(nodeModules, entry.name));
}

function prepareBetterSqlite3(serverRoot, arch = process.arch) {
  const moduleRoots = findBetterSqlite3Roots(serverRoot);
  if (moduleRoots.length === 0) {
    throw new Error(`[native-addon] No packaged better-sqlite3 module found under ${serverRoot}`);
  }

  for (const moduleRoot of moduleRoots) {
    const source = selectBetterSqlite3Prebuild(moduleRoot, arch);
    const target = path.join(moduleRoot, 'build', 'Release', addonName);
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
    } catch (error) {
      redirects.set(path.resolve(target), source);
      installReadOnlyFallback();
      console.warn(`[native-addon] ${target} is not writable; loading the ${arch} prebuild directly (${error.code || error.message})`);
    }
  }
}

module.exports = {
  prepareBetterSqlite3,
  selectBetterSqlite3Prebuild,
};
