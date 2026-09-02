import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

function listFiles(directory, suffix) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
    .map((entry) => join(directory, entry.name))
    .sort();
}

// The Linux build produces a local AppImage named "o8_<version>_amd64.AppImage"
// (see tests/release-artifacts.test.ts fixtures), but the publish-preview job
// in .github/workflows/port-build.yml re-uploads it under a different name:
// "o8_<version>_linux_amd64_preview.AppImage". The updater manifest url must
// point at the name the asset is actually published under, not the local
// build's basename.
const LINUX_APPIMAGE_NAME_PATTERN = /^o8_(.+)_amd64\.AppImage$/;

function publishedLinuxAssetName(version) {
  return `o8_${version}_linux_amd64_preview.AppImage`;
}

function assertLinuxAppImageVersionMatches(artifactPath, version) {
  const name = basename(artifactPath);
  const match = name.match(LINUX_APPIMAGE_NAME_PATTERN);
  if (!match) {
    throw new Error(
      `Linux AppImage release artifact "${name}" does not match the expected "o8_<version>_amd64.AppImage" naming pattern`,
    );
  }
  const [, appImageVersion] = match;
  if (appImageVersion !== version) {
    throw new Error(
      `Linux AppImage version "${appImageVersion}" (from "${name}") does not match release version "${version}"`,
    );
  }
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
    assertLinuxAppImageVersionMatches(linux.updater.artifactPath, version);
    platforms['linux-x86_64'] = {
      signature: readFileSync(linux.updater.signaturePath, 'utf8').trim(),
      url: `${downloadBase}/${publishedLinuxAssetName(version)}`,
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
