import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MACOS_RELEASE_ARCHITECTURES,
  readMachOArchitectures,
  resolveMacosReleaseArtifacts,
  verifyUniversalMacApp,
  verifyUniversalMacUpdaterArchive,
} from '../scripts/lib/macos-release-artifacts.mjs';

const roots: string[] = [];
const CPU_TYPE_X86_64 = 0x01000007;
const CPU_TYPE_ARM64 = 0x0100000c;

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function thinMachO(cpuType: number) {
  const binary = Buffer.alloc(32);
  binary.writeUInt32LE(0xfeedfacf, 0);
  binary.writeUInt32LE(cpuType, 4);
  return binary;
}

function universalMachO() {
  const slices = [thinMachO(CPU_TYPE_X86_64), thinMachO(CPU_TYPE_ARM64)];
  const headerBytes = 8 + slices.length * 20;
  const binary = Buffer.alloc(headerBytes + slices.reduce((sum, slice) => sum + slice.length, 0));
  binary.writeUInt32BE(0xcafebabe, 0);
  binary.writeUInt32BE(slices.length, 4);
  let offset = headerBytes;
  for (const [index, slice] of slices.entries()) {
    const entry = 8 + index * 20;
    binary.writeUInt32BE(index === 0 ? CPU_TYPE_X86_64 : CPU_TYPE_ARM64, entry);
    binary.writeUInt32BE(0, entry + 4);
    binary.writeUInt32BE(offset, entry + 8);
    binary.writeUInt32BE(slice.length, entry + 12);
    binary.writeUInt32BE(0, entry + 16);
    slice.copy(binary, offset);
    offset += slice.length;
  }
  return binary;
}

function appFixture() {
  const root = mkdtempSync(join(tmpdir(), 'o8-universal-app-'));
  roots.push(root);
  const app = join(root, 'o8.app');
  for (const name of ['o8', 'speech_recognizer', 'speech-local']) {
    const path = join(app, 'Contents', 'MacOS', name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, universalMachO());
  }
  return app;
}

function archiveFixture(app: string) {
  const archive = join(dirname(app), 'o8.app.tar.gz');
  execFileSync('tar', ['czf', archive, '-C', dirname(app), 'o8.app']);
  return archive;
}

describe('stable macOS release artifact identity', () => {
  it('resolves the universal target without inferring architecture from an x64 filename', () => {
    expect(resolveMacosReleaseArtifacts('/repo', '0.1.999')).toEqual({
      target: 'universal-apple-darwin',
      bundleDir: '/repo/src-tauri/target/universal-apple-darwin/release/bundle',
      app: '/repo/src-tauri/target/universal-apple-darwin/release/bundle/macos/o8.app',
      updaterArchive: '/repo/src-tauri/target/universal-apple-darwin/release/bundle/macos/o8.app.tar.gz',
      updaterSignature: '/repo/src-tauri/target/universal-apple-darwin/release/bundle/macos/o8.app.tar.gz.sig',
      dmg: '/repo/src-tauri/target/universal-apple-darwin/release/bundle/dmg/o8_0.1.999_universal.dmg',
    });
  });

  it('proves both slices from Mach-O bytes for the app and required sidecars', () => {
    const app = appFixture();
    const identity = verifyUniversalMacApp(app);

    expect(identity.kind).toBe('macos-universal-app');
    expect(identity.architectures).toEqual(MACOS_RELEASE_ARCHITECTURES);
    expect(identity.binaries.map((binary) => binary.relativePath)).toEqual([
      'Contents/MacOS/o8',
      'Contents/MacOS/speech_recognizer',
      'Contents/MacOS/speech-local',
    ]);
    expect(identity.binaries.every((binary) => binary.sha256.length === 64)).toBe(true);
    expect(readMachOArchitectures(join(app, 'Contents/MacOS/o8')))
      .toEqual(MACOS_RELEASE_ARCHITECTURES);
  });

  it('refuses an x86_64-only app before it can back the arm64 updater entry', () => {
    const app = appFixture();
    writeFileSync(join(app, 'Contents/MacOS/o8'), thinMachO(CPU_TYPE_X86_64));

    expect(() => verifyUniversalMacApp(app)).toThrow(
      'Contents/MacOS/o8 is missing required Mach-O architecture arm64',
    );
  });

  it('refuses a fat header whose declared slice does not match its embedded Mach-O', () => {
    const app = appFixture();
    const binary = universalMachO();
    binary.writeUInt32LE(CPU_TYPE_X86_64, 48 + 32 + 4);
    writeFileSync(join(app, 'Contents/MacOS/speech-local'), binary);

    expect(() => verifyUniversalMacApp(app)).toThrow('fat Mach-O slice CPU type mismatch');
  });

  it('binds the updater archive contents to the inspected universal app', () => {
    const app = appFixture();
    const archive = archiveFixture(app);

    const identity = verifyUniversalMacUpdaterArchive(app, archive);

    expect(identity.updaterArchiveSha256).toHaveLength(64);
    expect(identity.bundleSha256).toHaveLength(64);
    expect(identity.binaries.every((binary) => binary.architectures.length === 2)).toBe(true);
  });

  it('refuses a thin updater archive even when the loose app is universal', () => {
    const app = appFixture();
    writeFileSync(join(app, 'Contents/MacOS/o8'), thinMachO(CPU_TYPE_X86_64));
    const archive = archiveFixture(app);
    writeFileSync(join(app, 'Contents/MacOS/o8'), universalMachO());

    expect(() => verifyUniversalMacUpdaterArchive(app, archive)).toThrow(
      'archived Contents/MacOS/o8 is missing required Mach-O architecture arm64',
    );
  });

  it('refuses a stale universal updater archive whose contents differ from the loose app', () => {
    const app = appFixture();
    const archive = archiveFixture(app);
    writeFileSync(join(app, 'Contents', 'release-identity.txt'), 'new build');

    expect(() => verifyUniversalMacUpdaterArchive(app, archive)).toThrow(
      'updater archive contents do not match the inspected macOS app bundle',
    );
  });
});
