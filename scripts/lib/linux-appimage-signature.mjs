import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { linuxUpdaterPlatform, publishedLinuxAssetName } from './release-manifest.mjs';

// The updater signing key never leaves the ship machine, so this step is
// operator-invoked: CI builds the AppImage with `createUpdaterArtifacts: false`
// and publishes it unsigned, and the operator signs the published asset here
// with the same minisign key the macOS updater artifact is signed with.
export const SIGNER_COMMAND = 'cargo';
export const SIGNER_ARGS = ['tauri', 'signer', 'sign'];
export const GH_COMMAND = 'gh';
export const SIGNING_KEY_ENV = 'TAURI_SIGNING_PRIVATE_KEY';
export const SIGNING_KEY_PASSWORD_ENV = 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD';
export const SIGNING_KEY_RELATIVE_PATH = ['.tauri', 'cortex-ide.key'];
export const DARWIN_UPDATER_ASSET = 'o8.app.tar.gz';
export const LATEST_JSON_ASSET = 'latest.json';
export const DEFAULT_REPOS = ['hurttlocker/o8', 'hurttlocker/o8-releases'];

const TAG_PATTERN = /^v(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/;

export function versionFromTag(tag) {
  const match = TAG_PATTERN.exec(String(tag ?? '').trim());
  if (!match) {
    throw new Error(`release tag must look like v0.1.724 (received ${JSON.stringify(String(tag ?? ''))})`);
  }
  return match[1];
}

/**
 * The key is read from the same place the signed macOS build reads it: the
 * TAURI_SIGNING_PRIVATE_KEY env var, else the operator key file the
 * `tauri:build:signed` script already points at. Absent → fail closed; the
 * value is never logged.
 */
export function resolveSigningKey({
  env = process.env,
  fileExists = existsSync,
  readFile = (path) => readFileSync(path, 'utf8'),
} = {}) {
  const fromEnv = env[SIGNING_KEY_ENV]?.trim();
  if (fromEnv) return fromEnv;
  const home = env.HOME?.trim();
  const keyPath = home ? join(home, ...SIGNING_KEY_RELATIVE_PATH) : null;
  if (!keyPath || !fileExists(keyPath)) {
    throw new Error(
      `updater signing key unavailable: set ${SIGNING_KEY_ENV}, or run this on the ship machine where the operator key lives. Signing never runs on a CI runner.`,
    );
  }
  const key = readFile(keyPath).trim();
  if (!key) throw new Error(`updater signing key at ${keyPath} is empty`);
  return key;
}

/**
 * Adds the linux-x86_64 platform to an already-published latest.json. Darwin
 * entries are carried across by reference so they stay byte-for-byte identical.
 */
export function withLinuxPlatform({ latest, version, signature }) {
  const platforms = latest?.platforms;
  const darwin = platforms?.['darwin-x86_64'];
  if (!darwin || typeof darwin.url !== 'string') {
    throw new Error('published latest.json has no darwin-x86_64 url to anchor the download base on');
  }
  if (!darwin.url.endsWith(`/${DARWIN_UPDATER_ASSET}`)) {
    throw new Error(`published latest.json darwin-x86_64 url does not end in /${DARWIN_UPDATER_ASSET}: ${darwin.url}`);
  }
  if (latest.version !== version) {
    throw new Error(`published latest.json is version ${latest.version}, not ${version}`);
  }
  const downloadBase = darwin.url.slice(0, -(DARWIN_UPDATER_ASSET.length + 1));
  return {
    ...latest,
    platforms: {
      ...platforms,
      'linux-x86_64': linuxUpdaterPlatform({ version, signature, downloadBase }),
    },
  };
}

function defaultRun(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'inherit'] : ['ignore', 'inherit', 'inherit'],
    env: options.env,
  });
}

export function createLinuxSignatureDeps({
  run = defaultRun,
  env = process.env,
  readFile = (path) => readFileSync(path, 'utf8'),
  writeFile = (path, contents) => writeFileSync(path, contents),
} = {}) {
  return {
    resolveSigningKey: () => resolveSigningKey({ env }),
    fetchRelease: ({ repo, tag }) => {
      let stdout;
      try {
        stdout = run(GH_COMMAND, ['release', 'view', tag, '--repo', repo, '--json', 'isDraft,assets'], { capture: true });
      } catch {
        return null;
      }
      const parsed = JSON.parse(stdout);
      return {
        isDraft: parsed.isDraft === true,
        assets: (parsed.assets ?? []).map((asset) => asset.name),
      };
    },
    downloadAsset: ({ repo, tag, assetName, destDir }) => {
      run(GH_COMMAND, ['release', 'download', tag, '--repo', repo, '--pattern', assetName, '--dir', destDir, '--clobber']);
      return join(destDir, assetName);
    },
    signAppImage: ({ filePath, signingKey }) => {
      // Same invocation the macOS updater artifact is signed with: the key
      // rides the env var (newer tauri-cli rejects --private-key-path when the
      // env var is set too) with an empty password and stdin closed.
      run(SIGNER_COMMAND, [...SIGNER_ARGS, filePath], {
        env: { ...env, [SIGNING_KEY_ENV]: signingKey, [SIGNING_KEY_PASSWORD_ENV]: '' },
      });
      return `${filePath}.sig`;
    },
    readSignature: ({ sigPath }) => readFile(sigPath),
    fetchLatestJson: ({ repo, tag, destDir }) => {
      run(GH_COMMAND, ['release', 'download', tag, '--repo', repo, '--pattern', LATEST_JSON_ASSET, '--dir', destDir, '--clobber']);
      return JSON.parse(readFile(join(destDir, LATEST_JSON_ASSET)));
    },
    writeLatestJson: ({ path, latest }) => writeFile(path, `${JSON.stringify(latest, null, 2)}\n`),
    uploadAssets: ({ repo, tag, files }) => {
      run(GH_COMMAND, ['release', 'upload', tag, ...files, '--clobber', '--repo', repo]);
    },
  };
}

/**
 * Downloads the tag's published AppImage, signs it with the updater key, and
 * republishes the signature plus a latest.json that gains exactly one
 * linux-x86_64 entry. Every precondition fails closed before the key is used.
 */
export async function signLinuxAppImage({ tag, repos = DEFAULT_REPOS, workDir, deps, log = () => {} }) {
  const version = versionFromTag(tag);
  if (!Array.isArray(repos) || repos.length === 0) throw new Error('at least one target repository is required');
  if (!workDir) throw new Error('a work directory is required');
  const assetName = publishedLinuxAssetName(version);

  const signingKey = await deps.resolveSigningKey();

  // Every repo that will carry the manifest must already hold the AppImage the
  // manifest url points at, or the updater would resolve to a 404.
  for (const repo of repos) {
    const release = await deps.fetchRelease({ repo, tag });
    if (!release) throw new Error(`release ${tag} was not found in ${repo}`);
    if (release.isDraft) throw new Error(`release ${tag} in ${repo} is a draft — publish it before signing the Linux AppImage`);
    if (!release.assets.includes(assetName)) {
      const present = release.assets.filter((name) => name.endsWith('.AppImage'));
      throw new Error(
        `release ${tag} in ${repo} has no ${assetName} asset`
        + (present.length > 0 ? ` (AppImage assets present: ${present.join(', ')})` : ''),
      );
    }
  }

  const [primary] = repos;
  log(`downloading ${assetName} from ${primary}`);
  const appImagePath = await deps.downloadAsset({ repo: primary, tag, assetName, destDir: workDir });

  log(`signing ${assetName}`);
  const sigPath = await deps.signAppImage({ filePath: appImagePath, signingKey });
  const signature = (await deps.readSignature({ sigPath }))?.trim();
  if (!signature) throw new Error(`the signer produced no signature at ${sigPath}`);

  const publishedLatest = await deps.fetchLatestJson({ repo: primary, tag, destDir: workDir });
  const latest = withLinuxPlatform({ latest: publishedLatest, version, signature });
  const latestJsonPath = join(workDir, LATEST_JSON_ASSET);
  await deps.writeLatestJson({ path: latestJsonPath, latest });

  for (const repo of repos) {
    log(`uploading ${assetName}.sig + ${LATEST_JSON_ASSET} to ${repo}`);
    await deps.uploadAssets({ repo, tag, files: [sigPath, latestJsonPath] });
  }

  return { version, assetName, sigPath, latestJsonPath, latest, repos: [...repos] };
}
