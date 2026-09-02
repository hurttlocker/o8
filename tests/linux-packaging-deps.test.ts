import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// #2055 — a clean Linux install launched straight to the Node pre-flight
// dialog because the deb/rpm bundler config declared no nodejs dependency.
// `bundle.externalBin` stays null on Linux (the Tauri sidecar wants a
// SYSTEM Node), so the packaging config is the only thing standing between
// a fresh `apt install ./o8.deb` and a broken first launch. This test reads
// the real config the build merges (`src-tauri/tauri.linux.conf.json`,
// auto-merged by the Tauri CLI for Linux targets per tauri-utils'
// `BundleConfig.linux` — see `LinuxConfig` / `DebConfig.depends` /
// `RpmConfig.depends` in the vendored tauri-utils crate) so a future edit
// cannot silently drop the dependency without failing CI.
const CONFIG_PATH = join(__dirname, '..', 'src-tauri', 'tauri.linux.conf.json');

function readLinuxConfig(): {
  bundle?: { linux?: { deb?: { depends?: string[] }; rpm?: { depends?: string[] } } };
} {
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
}

describe('Linux packaging nodejs dependency (#2055)', () => {
  it('declares a nodejs >= 22 dependency for the deb bundle', () => {
    const config = readLinuxConfig();
    const depends = config.bundle?.linux?.deb?.depends ?? [];
    const nodejsEntry = depends.find((d) => /^nodejs\b/.test(d));
    expect(nodejsEntry).toBeDefined();
    expect(nodejsEntry).toMatch(/>=\s*22/);
  });

  it('declares a nodejs >= 22 dependency for the rpm bundle', () => {
    const config = readLinuxConfig();
    const depends = config.bundle?.linux?.rpm?.depends ?? [];
    const nodejsEntry = depends.find((d) => /^nodejs\b/.test(d));
    expect(nodejsEntry).toBeDefined();
    expect(nodejsEntry).toMatch(/>=\s*22/);
  });
});
