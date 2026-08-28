import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

function listFiles(directory, suffix) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
    .map((entry) => join(directory, entry.name))
    .sort();
}

function discoverLinuxArtifacts(bundleDir) {
  const appImageDir = join(bundleDir, 'appimage');
  const appImages = listFiles(appImageDir, '.AppImage');
  const signatures = listFiles(appImageDir, '.AppImage.sig');
  const signedAppImages = appImages
    .map((artifactPath) => ({ artifactPath, signaturePath: `${artifactPath}.sig` }))
    .filter(({ signaturePath }) => existsSync(signaturePath));

  if (appImages.length !== signedAppImages.length || signatures.length !== signedAppImages.length) {
    throw new Error('Linux AppImage release artifacts must include one matching .AppImage.sig file per AppImage');
  }
  if (signedAppImages.length > 1) {
    throw new Error('Expected at most one signed Linux AppImage release artifact');
  }

  const updater = signedAppImages[0] ?? null;
  const uploadAssets = updater
    ? [updater.artifactPath, updater.signaturePath]
    : [];
  uploadAssets.push(...listFiles(join(bundleDir, 'deb'), '.deb'));

  return { updater, uploadAssets };
}

export function buildReleaseManifest({
  bundleDir,
  version,
  notes,
  pubDate,
  downloadBase,
  darwinSignature,
  baseUploadAssets = [],
  trailingUploadAssets = [],
}) {
  const linux = discoverLinuxArtifacts(bundleDir);
  const platforms = {
    'darwin-x86_64': {
      signature: darwinSignature,
      url: `${downloadBase}/o8.app.tar.gz`,
    },
    'darwin-aarch64': {
      signature: darwinSignature,
      url: `${downloadBase}/o8.app.tar.gz`,
    },
  };

  if (linux.updater) {
    platforms['linux-x86_64'] = {
      signature: readFileSync(linux.updater.signaturePath, 'utf8').trim(),
      url: `${downloadBase}/${basename(linux.updater.artifactPath)}`,
    };
  }

  return {
    latestJson: {
      version,
      notes,
      pub_date: pubDate,
      platforms,
    },
    uploadArgs: [
      ...baseUploadAssets,
      ...linux.uploadAssets,
      ...trailingUploadAssets,
    ],
  };
}
