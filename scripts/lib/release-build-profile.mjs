import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

function canonicalFuturePath(value) {
  const absolute = resolve(value);
  if (existsSync(absolute)) return realpathSync(absolute);
  return join(canonicalFuturePath(dirname(absolute)), relative(dirname(absolute), absolute));
}

function overlaps(left, right) {
  return left === right || left.startsWith(right + sep) || right.startsWith(left + sep);
}

/** Lifecycle records outlive compiler calls. Never recursively dispose this profile. */
export function releaseBuildProfile(root, env = process.env, { release = false, create = true } = {}) {
  const home = realpathSync(env.HOME || homedir());
  const operator = canonicalFuturePath(env.O8_OPERATOR_DATA_DIR
    || (release && (env.O8_DATA_DIR || env.CORTEX_IDE_DATA_DIR)) || join(home, '.o8'));
  const explicit = env.O8_RELEASE_BUILD_DATA_DIR
    || (!release && (env.O8_DATA_DIR || env.CORTEX_IDE_DATA_DIR));
  if (explicit && !isAbsolute(explicit)) throw new Error('Build lifecycle profile must be absolute.');
  const selected = explicit || join(home, '.o8-release-build-profiles',
    createHash('sha256').update(realpathSync(root)).digest('hex'));
  const profile = canonicalFuturePath(selected);
  if (overlaps(profile, operator) || overlaps(profile, realpathSync(root))) {
    throw new Error('Build lifecycle profile must be separate from operator state and source output.');
  }
  if (existsSync(selected) && (lstatSync(selected).isSymbolicLink() || !lstatSync(selected).isDirectory())) {
    throw new Error('Build lifecycle profile is redirected or not a directory.');
  }
  const db = env.CORTEX_IDE_DB_PATH;
  if (db && (!isAbsolute(db) || dirname(canonicalFuturePath(db)) !== profile)) {
    throw new Error('Build lifecycle database must belong to the selected build profile.');
  }
  if (create) mkdirSync(profile, { recursive: true, mode: 0o700 });
  return { profile, operator };
}

export function prebuildEnvironment(root, env = process.env) {
  const { profile, operator } = releaseBuildProfile(root, env);
  return { ...env, O8_DATA_DIR: profile, CORTEX_IDE_DATA_DIR: profile, O8_OPERATOR_DATA_DIR: operator };
}

/** Route only the explicit/current runtime profile or this workspace's known build profile. */
export function boundBuildEnvironment(root, env = process.env) {
  const workspace = realpathSync(root);
  const home = realpathSync(env.HOME || homedir());
  const defaultProfile = join(home, '.o8-release-build-profiles',
    createHash('sha256').update(workspace).digest('hex'));
  const defaultDatabase = join(defaultProfile, 'cortex-ide.db');
  const marker = join(workspace, '.o8-generated-output-store');
  if (!existsSync(marker)) {
    // A different selected DB cannot erase this known private profile's authority.
    if (existsSync(defaultDatabase)) {
      throw new Error('Prebuild lifecycle store binding is missing; preserve output for recovery.');
    }
    return env;
  }
  const stat = lstatSync(marker);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== 64) {
    throw new Error('Bound output lifecycle store binding is invalid.');
  }
  const binding = readFileSync(marker, 'utf8');
  const matches = database => existsSync(database)
    && binding === createHash('sha256').update(realpathSync(database)).digest('hex');
  const explicit = env.O8_RELEASE_BUILD_DATA_DIR || env.O8_DATA_DIR || env.CORTEX_IDE_DATA_DIR;
  const runtimeProfile = explicit || join(home, '.o8');
  const runtimeDatabase = env.CORTEX_IDE_DB_PATH || join(runtimeProfile, 'cortex-ide.db');
  if (matches(runtimeDatabase)) {
    // Existing managed output keeps its original runtime DB and owner contract.
    // The producer validates the bound row and current manager before admission.
    return env.O8_RELEASE_BUILD_DATA_DIR
      ? { ...env, O8_DATA_DIR: runtimeProfile, CORTEX_IDE_DATA_DIR: runtimeProfile,
        CORTEX_IDE_DB_PATH: runtimeDatabase } : env;
  }
  if (explicit || env.CORTEX_IDE_DB_PATH) {
    throw new Error('Bound output lifecycle profile is explicitly mismatched.');
  }
  if (!matches(defaultDatabase)) {
    throw new Error('Bound output lifecycle profile is missing or mismatched.');
  }
  return { ...env, O8_DATA_DIR: defaultProfile, CORTEX_IDE_DATA_DIR: defaultProfile,
    CORTEX_IDE_DB_PATH: defaultDatabase,
    O8_OPERATOR_DATA_DIR: env.O8_OPERATOR_DATA_DIR || join(home, '.o8') };
}
