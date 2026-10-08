import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const MACOS_RELEASE_TARGET = 'universal-apple-darwin';
export const MACOS_RELEASE_ARCHITECTURES = Object.freeze(['x86_64', 'arm64']);

const CPU_ARCH_ABI64 = 0x01000000;
const CPU_TYPE_X86 = 7;
const CPU_TYPE_ARM = 12;
const CPU_TYPE_X86_64 = CPU_ARCH_ABI64 | CPU_TYPE_X86;
const CPU_TYPE_ARM64 = CPU_ARCH_ABI64 | CPU_TYPE_ARM;
const FAT_MAGIC = 0xcafebabe;
const FAT_CIGAM = 0xbebafeca;
const FAT_MAGIC_64 = 0xcafebabf;
const FAT_CIGAM_64 = 0xbfbafeca;
const MH_MAGIC = 0xfeedface;
const MH_MAGIC_64 = 0xfeedfacf;

const REQUIRED_BINARIES = Object.freeze([
  'Contents/MacOS/o8',
  'Contents/MacOS/speech_recognizer',
  'Contents/MacOS/speech-local',
  'Contents/MacOS/o8-pi-write',
]);

function architectureForCpuType(cpuType) {
  if (cpuType === CPU_TYPE_X86_64) return 'x86_64';
  if (cpuType === CPU_TYPE_ARM64) return 'arm64';
  throw new Error(`unsupported Mach-O CPU type 0x${cpuType.toString(16)}`);
}

function assertReadableRange(buffer, offset, bytes, label) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(bytes)
    || offset < 0 || bytes < 0 || offset + bytes > buffer.length) {
    throw new Error(`${label} exceeds file bounds`);
  }
}

function readUInt32(buffer, offset, littleEndian) {
  assertReadableRange(buffer, offset, 4, 'Mach-O header');
  return littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
}

function readUInt64(buffer, offset, littleEndian) {
  assertReadableRange(buffer, offset, 8, 'Mach-O header');
  const value = littleEndian ? buffer.readBigUInt64LE(offset) : buffer.readBigUInt64BE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Mach-O slice offset exceeds safe integer range');
  return Number(value);
}

function thinCpuType(buffer, offset = 0) {
  assertReadableRange(buffer, offset, 8, 'thin Mach-O header');
  const littleMagic = buffer.readUInt32LE(offset);
  if (littleMagic === MH_MAGIC || littleMagic === MH_MAGIC_64) {
    return buffer.readUInt32LE(offset + 4);
  }
  const bigMagic = buffer.readUInt32BE(offset);
  if (bigMagic === MH_MAGIC || bigMagic === MH_MAGIC_64) {
    return buffer.readUInt32BE(offset + 4);
  }
  throw new Error('file is not a thin Mach-O binary');
}

function fatArchitectures(buffer, littleEndian, is64Bit) {
  const count = readUInt32(buffer, 4, littleEndian);
  if (count < 1 || count > 64) throw new Error(`invalid fat Mach-O architecture count ${count}`);
  const entryBytes = is64Bit ? 32 : 20;
  assertReadableRange(buffer, 8, count * entryBytes, 'fat Mach-O architecture table');
  const architectures = [];
  for (let index = 0; index < count; index += 1) {
    const entryOffset = 8 + index * entryBytes;
    const declaredCpuType = readUInt32(buffer, entryOffset, littleEndian);
    const sliceOffset = is64Bit
      ? readUInt64(buffer, entryOffset + 8, littleEndian)
      : readUInt32(buffer, entryOffset + 8, littleEndian);
    const sliceBytes = is64Bit
      ? readUInt64(buffer, entryOffset + 16, littleEndian)
      : readUInt32(buffer, entryOffset + 12, littleEndian);
    assertReadableRange(buffer, sliceOffset, sliceBytes, 'fat Mach-O slice');
    if (sliceBytes < 8) throw new Error('fat Mach-O slice is too short');
    const embeddedCpuType = thinCpuType(buffer, sliceOffset);
    if (embeddedCpuType !== declaredCpuType) throw new Error('fat Mach-O slice CPU type mismatch');
    architectures.push(architectureForCpuType(declaredCpuType));
  }
  return [...new Set(architectures)];
}

export function readMachOArchitectures(path) {
  const binary = readFileSync(path);
  assertReadableRange(binary, 0, 8, 'Mach-O header');
  const magic = binary.readUInt32BE(0);
  let architectures;
  if (magic === FAT_MAGIC || magic === FAT_MAGIC_64) {
    architectures = fatArchitectures(binary, false, magic === FAT_MAGIC_64);
  } else if (magic === FAT_CIGAM || magic === FAT_CIGAM_64) {
    architectures = fatArchitectures(binary, true, magic === FAT_CIGAM_64);
  } else {
    architectures = [architectureForCpuType(thinCpuType(binary))];
  }
  return MACOS_RELEASE_ARCHITECTURES.filter((architecture) => architectures.includes(architecture));
}

export function resolveMacosReleaseArtifacts(root, version) {
  const bundleDir = join(root, 'src-tauri', 'target', MACOS_RELEASE_TARGET, 'release', 'bundle');
  const macosDir = join(bundleDir, 'macos');
  return {
    target: MACOS_RELEASE_TARGET,
    bundleDir,
    app: join(macosDir, 'o8.app'),
    updaterArchive: join(macosDir, 'o8.app.tar.gz'),
    updaterSignature: join(macosDir, 'o8.app.tar.gz.sig'),
    dmg: join(bundleDir, 'dmg', `o8_${version}_universal.dmg`),
  };
}

export function verifyUniversalMacApp(appPath) {
  const binaries = REQUIRED_BINARIES.map((relativePath) => {
    const path = join(appPath, ...relativePath.split('/'));
    if (!existsSync(path)) throw new Error(`${relativePath} is missing from the macOS app bundle`);
    let architectures;
    try {
      architectures = readMachOArchitectures(path);
    } catch (error) {
      throw new Error(`${relativePath} failed Mach-O inspection: ${error instanceof Error ? error.message : String(error)}`);
    }
    for (const architecture of MACOS_RELEASE_ARCHITECTURES) {
      if (!architectures.includes(architecture)) {
        throw new Error(`${relativePath} is missing required Mach-O architecture ${architecture}`);
      }
    }
    return {
      relativePath,
      architectures,
      sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
    };
  });
  return {
    kind: 'macos-universal-app',
    architectures: [...MACOS_RELEASE_ARCHITECTURES],
    binaries,
  };
}

function bundleContentSha256(appPath) {
  const digest = createHash('sha256');

  function visit(path, relativePath) {
    const stat = lstatSync(path);
    const normalizedPath = relativePath.split(sep).join('/');
    const mode = (stat.mode & 0o7777).toString(8);
    if (stat.isDirectory()) {
      digest.update(`directory\0${normalizedPath}\0${mode}\0`);
      for (const name of readdirSync(path).sort()) visit(join(path, name), join(relativePath, name));
      return;
    }
    if (stat.isFile()) {
      digest.update(`file\0${normalizedPath}\0${mode}\0${stat.size}\0`);
      digest.update(readFileSync(path));
      digest.update('\0');
      return;
    }
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(path);
      const resolvedTarget = resolve(dirname(path), target);
      const targetRelative = relative(appPath, resolvedTarget);
      if (isAbsolute(target) || targetRelative === '..' || targetRelative.startsWith(`..${sep}`)) {
        throw new Error(`${normalizedPath} has an unsafe symlink target outside o8.app`);
      }
      digest.update(`symlink\0${normalizedPath}\0${target}\0`);
      return;
    }
    throw new Error(`${normalizedPath} has an unsupported filesystem entry type`);
  }

  visit(appPath, 'o8.app');
  return digest.digest('hex');
}

function validateUpdaterArchiveMembers(archivePath) {
  const listing = execFileSync('tar', ['tzf', archivePath], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
  const members = listing.split('\n').filter(Boolean);
  if (members.length === 0) throw new Error('updater archive is empty');
  for (const member of members) {
    const normalized = member.replace(/\/+$/, '');
    const parts = normalized.split('/');
    if (isAbsolute(member) || parts.includes('..') || parts.includes('.') || parts[0] !== 'o8.app') {
      throw new Error(`updater archive contains unsafe member ${JSON.stringify(member)}`);
    }
  }
}

export function verifyUniversalMacUpdaterArchive(appPath, archivePath) {
  if (!existsSync(archivePath)) throw new Error('macOS updater archive is missing');
  verifyUniversalMacApp(appPath);
  validateUpdaterArchiveMembers(archivePath);
  const extractionRoot = mkdtempSync(join(tmpdir(), 'o8-updater-inspection-'));
  try {
    // Preserve archived modes so the caller's umask cannot change bundle identity.
    execFileSync('tar', ['xzpf', archivePath, '-C', extractionRoot], { stdio: 'pipe' });
    const entries = readdirSync(extractionRoot).sort();
    if (entries.length !== 1 || entries[0] !== 'o8.app') {
      throw new Error('updater archive must contain exactly one top-level o8.app bundle');
    }
    const archivedApp = join(extractionRoot, 'o8.app');
    let archivedIdentity;
    try {
      archivedIdentity = verifyUniversalMacApp(archivedApp);
    } catch (error) {
      throw new Error(`archived ${error instanceof Error ? error.message : String(error)}`);
    }
    const bundleSha256 = bundleContentSha256(appPath);
    const archivedBundleSha256 = bundleContentSha256(archivedApp);
    if (archivedBundleSha256 !== bundleSha256) {
      throw new Error('updater archive contents do not match the inspected macOS app bundle');
    }
    return {
      ...archivedIdentity,
      bundleSha256,
      updaterArchiveSha256: createHash('sha256').update(readFileSync(archivePath)).digest('hex'),
    };
  } finally {
    rmSync(extractionRoot, { recursive: true, force: true });
  }
}

export function verifyMacosDmgMatchesApp(appPath, dmgPath, version) {
  execFileSync('/usr/bin/hdiutil', ['verify', dmgPath], { stdio: 'pipe' });
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', dmgPath], { stdio: 'pipe' });

  const inspectionRoot = mkdtempSync(join(tmpdir(), 'o8-dmg-inspection-'));
  const mountPath = join(inspectionRoot, 'mount');
  mkdirSync(mountPath);
  let mounted = false;
  let identity;
  let verificationError;
  try {
    execFileSync('/usr/bin/hdiutil', [
      'attach',
      '-readonly',
      '-nobrowse',
      '-mountpoint', mountPath,
      dmgPath,
    ], { stdio: 'pipe' });
    mounted = true;
    const dmgApp = join(mountPath, 'o8.app');
    if (!existsSync(dmgApp)) throw new Error('DMG is missing its top-level o8.app bundle');
    execFileSync('/usr/bin/codesign', [
      '--verify',
      '--deep',
      '--strict',
      dmgApp,
    ], { stdio: 'pipe' });
    let dmgAppIdentity;
    try {
      dmgAppIdentity = verifyUniversalMacApp(dmgApp);
    } catch (error) {
      throw new Error(`DMG ${error instanceof Error ? error.message : String(error)}`);
    }
    const bundleVersion = execFileSync('/usr/bin/plutil', [
      '-extract',
      'CFBundleShortVersionString',
      'raw',
      '-o', '-',
      join(dmgApp, 'Contents', 'Info.plist'),
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    if (bundleVersion !== version) {
      throw new Error(`DMG app version ${JSON.stringify(bundleVersion)} does not match release version ${JSON.stringify(version)}`);
    }
    const bundleSha256 = bundleContentSha256(appPath);
    const dmgBundleSha256 = bundleContentSha256(dmgApp);
    if (dmgBundleSha256 !== bundleSha256) {
      throw new Error('DMG app contents do not match the inspected macOS app bundle');
    }
    identity = {
      ...dmgAppIdentity,
      bundleVersion,
      bundleSha256,
      dmgSha256: createHash('sha256').update(readFileSync(dmgPath)).digest('hex'),
    };
  } catch (error) {
    verificationError = error;
  }

  let cleanupError;
  if (mounted) {
    try {
      execFileSync('/usr/bin/hdiutil', ['detach', mountPath], { stdio: 'pipe' });
    } catch {
      try {
        execFileSync('/usr/bin/hdiutil', ['detach', mountPath, '-force'], { stdio: 'pipe' });
      } catch (error) {
        cleanupError = error;
      }
    }
  }
  if (!cleanupError) rmSync(inspectionRoot, { recursive: true, force: true });
  if (verificationError) {
    if (cleanupError) {
      throw new Error(
        `${verificationError instanceof Error ? verificationError.message : String(verificationError)}; DMG cleanup also failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      );
    }
    throw verificationError;
  }
  if (cleanupError) {
    throw new Error(`DMG verification passed but cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
  }
  return identity;
}
