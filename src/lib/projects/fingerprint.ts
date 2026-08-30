/**
 * #899 — AI project semantics, Stage 1 fingerprint extractor (deterministic).
 *
 * Reads the public-ish surface of a repo (manifest dep KEYS, README first 100
 * lines, top-level folders, deploy hints) and emits a ≤2KB JSON fingerprint
 * that Stage 2 (the LLM call, future wave) will turn into project semantics.
 *
 * Privacy is load-bearing here:
 *   - Never reads source code (.ts / .tsx / .py / .rs / .go bodies).
 *   - Never reads `.env` — only `.env.example`, KEYS only (split on `=`,
 *     discard the right side).
 *   - Manifest values (versions) are stripped — only dep names survive.
 *   - vercel.json / railway.json: top-level keys only, never values.
 *   - next.config: only safe extracts (rewrites presence, image hostnames,
 *     env keys) — pulled by regex, never via require/exec.
 *   - README capped at 100 lines × 200 chars.
 *
 * Hard size cap is 2KB after JSON.stringify(). The truncate path drops
 * `readme.firstLines` first, then deps, until we fit.
 */

import 'server-only';

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

// ── public types ──────────────────────────────────────────────────────────

export type ManifestType =
  | 'package.json'
  | 'cargo.toml'
  | 'pyproject.toml'
  | 'requirements.txt'
  | 'go.mod'
  | 'unknown';

export interface RepoFingerprint {
  repoId: string;
  /** sha256(canonicalize(rest)) — used for cache invalidation. */
  hash: string;
  generatedAt: number;
  github: {
    description?: string;
    topics?: string[];
    languages?: Record<string, number>;
    primaryLanguage?: string;
    homepage?: string;
  };
  manifest: {
    type: ManifestType;
    name?: string;
    description?: string;
    homepage?: string;
    dependencies?: string[];
    devDependencies?: string[];
  };
  readme?: {
    firstLines: string[];
    crossLinks?: string[];
  };
  topLevelFolders: string[];
  deployHints: {
    vercel?: string[];
    railway?: string[];
    docker?: boolean;
    fly?: boolean;
    wrangler?: boolean;
    nextConfig?: {
      hasRewrites?: boolean;
      hasImagesDomains?: string[];
      hasEnv?: string[];
    };
    envExampleKeys?: string[];
  };
}

/** GitHub-side metadata, supplied by the caller (we never fetch). */
export interface GithubMeta {
  description?: string;
  topics?: string[];
  languages?: Record<string, number>;
  primaryLanguage?: string;
  homepage?: string;
}

const MAX_BYTES = 2048;
const README_MAX_LINES = 100;
const README_MAX_LINE_LEN = 200;
const TOP_LEVEL_MAX = 30;
const READ_FILE_BUDGET = 256 * 1024; // hard cap on any single read

// ── safe IO ───────────────────────────────────────────────────────────────

function safeReadJson(path: string): unknown {
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, { encoding: 'utf-8' }).slice(0, READ_FILE_BUDGET);
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function safeReadText(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, { encoding: 'utf-8' }).slice(0, READ_FILE_BUDGET);
  } catch {
    return null;
  }
}

// ── manifest ──────────────────────────────────────────────────────────────

function pickType(repoPath: string): ManifestType {
  if (existsSync(join(repoPath, 'package.json'))) return 'package.json';
  if (existsSync(join(repoPath, 'Cargo.toml'))) return 'cargo.toml';
  if (existsSync(join(repoPath, 'pyproject.toml'))) return 'pyproject.toml';
  if (existsSync(join(repoPath, 'requirements.txt'))) return 'requirements.txt';
  if (existsSync(join(repoPath, 'go.mod'))) return 'go.mod';
  return 'unknown';
}

function readPackageJson(repoPath: string) {
  const parsed = safeReadJson(join(repoPath, 'package.json'));
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const out: {
    name?: string;
    description?: string;
    homepage?: string;
    dependencies?: string[];
    devDependencies?: string[];
  } = {};
  if (typeof obj.name === 'string') out.name = obj.name;
  if (typeof obj.description === 'string') out.description = obj.description;
  if (typeof obj.homepage === 'string') out.homepage = obj.homepage;
  for (const key of ['dependencies', 'devDependencies'] as const) {
    const block = obj[key];
    if (block && typeof block === 'object' && !Array.isArray(block)) {
      const names = Object.keys(block as Record<string, unknown>).filter(Boolean).sort();
      if (names.length > 0) out[key] = names;
    }
  }
  return out;
}

/**
 * Read top-level KEY names from a TOML table. Versions/values discarded.
 * Quoted keys ignored — Cargo/Pyproject deps are bare identifiers.
 */
function readTomlTableKeys(raw: string, tableName: string): string[] {
  const headerRe = new RegExp(
    `^\\[\\s*${tableName.replace(/\./g, '\\.')}\\s*\\]\\s*$`,
    'm',
  );
  const headerMatch = raw.match(headerRe);
  if (!headerMatch || headerMatch.index === undefined) return [];
  const after = raw.slice(headerMatch.index + headerMatch[0].length);
  const nextHeaderIdx = after.search(/^\[/m);
  const block = nextHeaderIdx >= 0 ? after.slice(0, nextHeaderIdx) : after;
  const keys: string[] = [];
  for (const line of block.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx <= 0) continue;
    const lhs = trimmed.slice(0, eqIdx).trim();
    const baseKey = lhs.split('.')[0]?.trim();
    if (!baseKey) continue;
    if (baseKey.startsWith('"') || baseKey.startsWith("'")) continue;
    if (!/^[A-Za-z0-9][A-Za-z0-9_\-]*$/.test(baseKey)) continue;
    keys.push(baseKey);
  }
  return keys;
}

function readCargoToml(repoPath: string) {
  const raw = safeReadText(join(repoPath, 'Cargo.toml'));
  if (!raw) return null;
  const out: { name?: string; description?: string; dependencies?: string[]; devDependencies?: string[] } = {};
  // Pull `name` and `description` from `[package]`.
  const pkgIdx = raw.search(/^\[\s*package\s*\]/m);
  if (pkgIdx >= 0) {
    const after = raw.slice(pkgIdx);
    const nextHdr = after.search(/\n\[/);
    const block = nextHdr >= 0 ? after.slice(0, nextHdr) : after;
    const nameM = block.match(/^\s*name\s*=\s*"([^"]+)"/m);
    if (nameM) out.name = nameM[1];
    const descM = block.match(/^\s*description\s*=\s*"([^"]+)"/m);
    if (descM) out.description = descM[1];
  }
  const deps = [...new Set(readTomlTableKeys(raw, 'dependencies'))].sort();
  const devDeps = [...new Set(readTomlTableKeys(raw, 'dev-dependencies'))].sort();
  if (deps.length > 0) out.dependencies = deps;
  if (devDeps.length > 0) out.devDependencies = devDeps;
  return out;
}

function readPyprojectToml(repoPath: string) {
  const raw = safeReadText(join(repoPath, 'pyproject.toml'));
  if (!raw) return null;
  const out: { name?: string; description?: string; dependencies?: string[]; devDependencies?: string[] } = {};
  const projectIdx = raw.search(/^\[\s*project\s*\]/m);
  if (projectIdx >= 0) {
    const after = raw.slice(projectIdx);
    const nextHdr = after.search(/\n\[/);
    const block = nextHdr >= 0 ? after.slice(0, nextHdr) : after;
    const nameM = block.match(/^\s*name\s*=\s*"([^"]+)"/m);
    if (nameM) out.name = nameM[1];
    const descM = block.match(/^\s*description\s*=\s*"([^"]+)"/m);
    if (descM) out.description = descM[1];
    const arrM = block.match(/^\s*dependencies\s*=\s*\[([\s\S]*?)\]/m);
    if (arrM) {
      const names = new Set<string>();
      for (const item of arrM[1].split(',')) {
        const cleaned = item.replace(/[#].*$/g, '').trim().replace(/^['"]|['"]$/g, '');
        const m = cleaned.match(/^([A-Za-z0-9][A-Za-z0-9_\-.]*)/);
        if (m?.[1]) names.add(m[1]);
      }
      if (names.size > 0) out.dependencies = [...names].sort();
    }
  }
  // Poetry layout
  const poetryDeps = readTomlTableKeys(raw, 'tool.poetry.dependencies');
  const poetryDevDeps = readTomlTableKeys(raw, 'tool.poetry.dev-dependencies');
  if (poetryDeps.length > 0) {
    out.dependencies = [...new Set([...(out.dependencies ?? []), ...poetryDeps])].sort();
  }
  if (poetryDevDeps.length > 0) {
    out.devDependencies = [...new Set([...(out.devDependencies ?? []), ...poetryDevDeps])].sort();
  }
  return out;
}

function readRequirementsTxt(repoPath: string) {
  const raw = safeReadText(join(repoPath, 'requirements.txt'));
  if (!raw) return null;
  const names = new Set<string>();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('-')) continue;
    // strip env markers + version specifiers
    const m = trimmed.match(/^([A-Za-z0-9][A-Za-z0-9_\-.]*)/);
    if (m?.[1]) names.add(m[1]);
  }
  if (names.size === 0) return null;
  return { dependencies: [...names].sort() };
}

function readGoMod(repoPath: string) {
  const raw = safeReadText(join(repoPath, 'go.mod'));
  if (!raw) return null;
  const out: { name?: string; dependencies?: string[] } = {};
  const moduleM = raw.match(/^\s*module\s+(\S+)/m);
  if (moduleM) out.name = moduleM[1];
  // require ( ... ) block; also single-line `require x v1.2.3`.
  const deps = new Set<string>();
  const reqBlock = raw.match(/^\s*require\s*\(([\s\S]*?)\)/m);
  if (reqBlock) {
    for (const line of reqBlock[1].split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//')) continue;
      const m = trimmed.match(/^(\S+)/);
      if (m?.[1]) deps.add(m[1]);
    }
  }
  for (const m of raw.matchAll(/^\s*require\s+(\S+)\s+\S/gm)) {
    if (m[1]) deps.add(m[1]);
  }
  if (deps.size > 0) out.dependencies = [...deps].sort();
  return out;
}

function readManifest(type: ManifestType, repoPath: string): RepoFingerprint['manifest'] {
  switch (type) {
    case 'package.json': {
      const m = readPackageJson(repoPath);
      return { type, ...(m ?? {}) };
    }
    case 'cargo.toml': {
      const m = readCargoToml(repoPath);
      return { type, ...(m ?? {}) };
    }
    case 'pyproject.toml': {
      const m = readPyprojectToml(repoPath);
      return { type, ...(m ?? {}) };
    }
    case 'requirements.txt': {
      const m = readRequirementsTxt(repoPath);
      return { type, ...(m ?? {}) };
    }
    case 'go.mod': {
      const m = readGoMod(repoPath);
      return { type, ...(m ?? {}) };
    }
    default:
      return { type: 'unknown' };
  }
}

// ── readme ────────────────────────────────────────────────────────────────

function readReadme(repoPath: string): RepoFingerprint['readme'] | undefined {
  // First match wins, in priority order.
  const candidates = ['README.md', 'README.MD', 'README', 'README.txt', 'readme.md'];
  let raw: string | null = null;
  for (const name of candidates) {
    raw = safeReadText(join(repoPath, name));
    if (raw) break;
  }
  if (!raw) return undefined;
  const lines: string[] = [];
  for (const line of raw.split('\n')) {
    if (lines.length >= README_MAX_LINES) break;
    const trimmed = line.replace(/\r$/, '');
    lines.push(trimmed.length > README_MAX_LINE_LEN ? trimmed.slice(0, README_MAX_LINE_LEN) : trimmed);
  }
  // GitHub URL extraction (full README, not just truncated lines, so we don't
  // miss a link in lines 101–200).
  const linkSet = new Set<string>();
  const linkRe = /\bhttps?:\/\/(?:www\.)?github\.com\/[A-Za-z0-9_.\-]+\/[A-Za-z0-9_.\-]+(?:\/[A-Za-z0-9_.\-/#?&=]*)?/g;
  for (const m of raw.matchAll(linkRe)) {
    // strip trailing punctuation that often clings to URLs in markdown.
    const url = m[0].replace(/[).,;:!\]]+$/, '');
    linkSet.add(url);
    if (linkSet.size >= 16) break;
  }
  return {
    firstLines: lines,
    crossLinks: [...linkSet].sort(),
  };
}

// ── top-level folders ─────────────────────────────────────────────────────

function readTopLevelFolders(repoPath: string): string[] {
  try {
    const entries = readdirSync(repoPath, { withFileTypes: true });
    const out: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      if (name === '.git' || name === 'node_modules') continue;
      out.push(name);
      if (out.length >= TOP_LEVEL_MAX * 2) break; // collect more then sort+slice
    }
    return out.sort().slice(0, TOP_LEVEL_MAX);
  } catch {
    return [];
  }
}

// ── deploy hints ──────────────────────────────────────────────────────────

function readJsonTopLevelKeys(repoPath: string, fileName: string): string[] | undefined {
  const parsed = safeReadJson(join(repoPath, fileName));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const keys = Object.keys(parsed as Record<string, unknown>).filter(Boolean).sort();
  return keys.length > 0 ? keys : undefined;
}

/**
 * Pull safe scraps from `next.config.{js,ts,mjs,cjs}` without executing it.
 *
 *   - hasRewrites: presence of an `async rewrites` definition.
 *   - hasImagesDomains: hostnames inside `images.{domains,remotePatterns}`.
 *     Hostname strings only — no protocols, no paths.
 *   - hasEnv: keys in the top-level `env: { ... }` block. Keys only, never
 *     values (some users inline secrets here, never our problem to leak).
 */
function readNextConfig(repoPath: string): RepoFingerprint['deployHints']['nextConfig'] | undefined {
  const candidates = ['next.config.js', 'next.config.ts', 'next.config.mjs', 'next.config.cjs'];
  let raw: string | null = null;
  for (const name of candidates) {
    raw = safeReadText(join(repoPath, name));
    if (raw) break;
  }
  if (!raw) return undefined;
  const out: NonNullable<RepoFingerprint['deployHints']['nextConfig']> = {};
  if (/\brewrites\s*\(/.test(raw) || /\brewrites\s*:/.test(raw)) out.hasRewrites = true;
  // images.domains: ['a.com', "b.com"]
  const domains = new Set<string>();
  const domainsBlock = raw.match(/\bdomains\s*:\s*\[([^\]]*)\]/);
  if (domainsBlock) {
    for (const m of domainsBlock[1].matchAll(/['"]([A-Za-z0-9.\-]+)['"]/g)) {
      if (m[1]) domains.add(m[1]);
    }
  }
  // remotePatterns: [{ hostname: 'x' }, ...]
  for (const m of raw.matchAll(/hostname\s*:\s*['"]([A-Za-z0-9.\-]+)['"]/g)) {
    if (m[1]) domains.add(m[1]);
  }
  if (domains.size > 0) out.hasImagesDomains = [...domains].sort();
  // env: { KEY: ... } — keys only.
  const envBlock = raw.match(/\benv\s*:\s*\{([\s\S]*?)\}/);
  if (envBlock) {
    const keys = new Set<string>();
    for (const m of envBlock[1].matchAll(/['"]?([A-Z][A-Z0-9_]+)['"]?\s*:/g)) {
      if (m[1]) keys.add(m[1]);
    }
    if (keys.size > 0) out.hasEnv = [...keys].sort();
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * `.env.example` → KEY names only. Splits each line on `=`, discards the
 * right side. Comments and blanks ignored.
 */
function readEnvExampleKeys(repoPath: string): string[] | undefined {
  const raw = safeReadText(join(repoPath, '.env.example'));
  if (!raw) return undefined;
  const keys = new Set<string>();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = trimmed.slice(0, eqIdx).trim().replace(/^export\s+/, '');
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) keys.add(key);
  }
  if (keys.size === 0) return undefined;
  return [...keys].sort();
}

function readDeployHints(repoPath: string): RepoFingerprint['deployHints'] {
  const out: RepoFingerprint['deployHints'] = {};
  const vercel = readJsonTopLevelKeys(repoPath, 'vercel.json');
  if (vercel) out.vercel = vercel;
  const railway = readJsonTopLevelKeys(repoPath, 'railway.json');
  if (railway) out.railway = railway;
  if (existsSync(join(repoPath, 'Dockerfile'))) out.docker = true;
  if (existsSync(join(repoPath, 'fly.toml'))) out.fly = true;
  if (existsSync(join(repoPath, 'wrangler.toml'))) out.wrangler = true;
  const nextCfg = readNextConfig(repoPath);
  if (nextCfg) out.nextConfig = nextCfg;
  const envKeys = readEnvExampleKeys(repoPath);
  if (envKeys) out.envExampleKeys = envKeys;
  return out;
}

// ── canonicalize + hash + size cap ───────────────────────────────────────

/**
 * Stable JSON: keys sorted recursively. Two fingerprints with identical
 * content always produce the same string, so the hash is reproducible.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(value, sortReplacer);
}

function sortReplacer(_key: string, val: unknown): unknown {
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    const obj = val as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = obj[k];
    return out;
  }
  return val;
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(canonicalize(value), 'utf-8');
}

/**
 * Trim the fingerprint until JSON.stringify(fingerprint) ≤ 2KB. We attack
 * the largest known offenders first (readme.firstLines, then deps lists),
 * so the operationally most useful fields (deploy hints, manifest type,
 * cross-links) survive.
 */
function enforceSizeCap(fp: RepoFingerprint): RepoFingerprint {
  if (byteLength(fp) <= MAX_BYTES) return fp;
  // 1) Halve readme firstLines, repeatedly, until empty.
  if (fp.readme?.firstLines?.length) {
    while (fp.readme.firstLines.length > 0 && byteLength(fp) > MAX_BYTES) {
      const next = Math.floor(fp.readme.firstLines.length / 2);
      fp.readme.firstLines = fp.readme.firstLines.slice(0, next);
      if (next === 0) break;
    }
    if (fp.readme.firstLines.length === 0 && (!fp.readme.crossLinks || fp.readme.crossLinks.length === 0)) {
      delete fp.readme;
    }
  }
  if (byteLength(fp) <= MAX_BYTES) return fp;
  // 2) Drop devDependencies.
  if (fp.manifest.devDependencies?.length) {
    delete fp.manifest.devDependencies;
  }
  if (byteLength(fp) <= MAX_BYTES) return fp;
  // 3) Halve dependencies.
  if (fp.manifest.dependencies?.length) {
    while (fp.manifest.dependencies.length > 0 && byteLength(fp) > MAX_BYTES) {
      const next = Math.floor(fp.manifest.dependencies.length / 2);
      fp.manifest.dependencies = fp.manifest.dependencies.slice(0, next);
      if (next === 0) break;
    }
    if (fp.manifest.dependencies?.length === 0) {
      delete fp.manifest.dependencies;
    }
  }
  if (byteLength(fp) <= MAX_BYTES) return fp;
  // 4) Drop crossLinks.
  if (fp.readme?.crossLinks) delete fp.readme.crossLinks;
  if (byteLength(fp) <= MAX_BYTES) return fp;
  // 5) Drop README entirely.
  if (fp.readme) delete fp.readme;
  if (byteLength(fp) <= MAX_BYTES) return fp;
  // 6) Drop topLevelFolders.
  if (fp.topLevelFolders.length > 0) fp.topLevelFolders = [];
  if (byteLength(fp) <= MAX_BYTES) return fp;
  // 7) Halve envExampleKeys (preserve deploy signal as long as possible).
  while (
    fp.deployHints.envExampleKeys &&
    fp.deployHints.envExampleKeys.length > 0 &&
    byteLength(fp) > MAX_BYTES
  ) {
    const next = Math.floor(fp.deployHints.envExampleKeys.length / 2);
    fp.deployHints.envExampleKeys = fp.deployHints.envExampleKeys.slice(0, next);
    if (next === 0) {
      delete fp.deployHints.envExampleKeys;
      break;
    }
  }
  if (byteLength(fp) <= MAX_BYTES) return fp;
  // 8) Last resort: drop manifest devDependencies + dependencies entirely.
  if (fp.manifest.devDependencies) delete fp.manifest.devDependencies;
  if (fp.manifest.dependencies) delete fp.manifest.dependencies;
  return fp;
}

function hashRest(fp: RepoFingerprint): string {
  // Hash everything *except* `hash` and `generatedAt` so the hash is content-
  // addressed — the same repo state yields the same hash regardless of when
  // the fingerprint was generated.
  const { hash: _h, generatedAt: _g, ...rest } = fp;
  return createHash('sha256').update(canonicalize(rest), 'utf-8').digest('hex');
}

// ── public surface ────────────────────────────────────────────────────────

/**
 * Compute a fingerprint for a single repo path. Synchronous + no-throw; a
 * missing repo path yields a valid skeleton (empty manifest, no readme).
 */
export function computeFingerprint(
  repoId: string,
  repoPath: string,
  github?: GithubMeta,
): RepoFingerprint {
  const safePath = repoPath?.trim() ?? '';
  const exists = safePath ? safeIsDir(safePath) : false;
  const manifestType = exists ? pickType(safePath) : 'unknown';
  const manifest = exists ? readManifest(manifestType, safePath) : { type: 'unknown' as const };
  const readme = exists ? readReadme(safePath) : undefined;
  const topLevelFolders = exists ? readTopLevelFolders(safePath) : [];
  const deployHints = exists ? readDeployHints(safePath) : {};

  // Strip undefined keys from github so hashing is stable.
  const githubFiltered: RepoFingerprint['github'] = {};
  if (github?.description) githubFiltered.description = github.description;
  if (github?.topics?.length) githubFiltered.topics = [...github.topics].sort();
  if (github?.languages && Object.keys(github.languages).length > 0) {
    githubFiltered.languages = github.languages;
  }
  if (github?.primaryLanguage) githubFiltered.primaryLanguage = github.primaryLanguage;
  if (github?.homepage) githubFiltered.homepage = github.homepage;

  const fp: RepoFingerprint = {
    repoId,
    // Placeholder of the same length the final sha256 hex will occupy, so
    // `enforceSizeCap` budgets correctly. Rewritten to the real digest below.
    hash: '0'.repeat(64),
    generatedAt: Date.now(),
    github: githubFiltered,
    manifest,
    ...(readme ? { readme } : {}),
    topLevelFolders,
    deployHints,
  };

  enforceSizeCap(fp);
  fp.hash = hashRest(fp);
  return fp;
}

function safeIsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export const __TEST = {
  MAX_BYTES,
  README_MAX_LINES,
  README_MAX_LINE_LEN,
  TOP_LEVEL_MAX,
  hashRest,
  enforceSizeCap,
  byteLength,
};
