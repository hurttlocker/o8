export function requirePiNode(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  if (!Number.isFinite(major) || major < 22 || (major === 22 && minor < 19)) {
    throw new Error('The Pi prototype needs Node 22.19 or newer. Install a supported runtime before starting; o8 will not install it automatically.');
  }
}

/** Approved writes rely on POSIX directory descriptors; Windows is refused until #3243 covers it. */
export function requirePiPlatform(platform: NodeJS.Platform = process.platform) {
  if (platform === 'win32') {
    throw new Error('The Pi prototype does not support Windows yet. Use macOS or Linux.');
  }
}
