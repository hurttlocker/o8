/**
 * Settings→MCP readiness gate (#2026-07-09 beta bug: "MCP still saying install
 * after days"). codebase-memory is OPTIONAL — the connect routes omit its entry
 * when the binary is missing — so its absence may only block Connect while a
 * download is GENUINELY in flight. Upstream deleted the pinned release's
 * assets, every fresh install's download 404'd at every launch, and the old
 * gate (exists(binary) ? ready : "still downloading") disabled the one-click
 * Connect forever. This suite pins the full state matrix, including the stale
 * "downloading" claim (crashed downloader) and the explicit error sentinel.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getMcpSetupReadiness } from '@/lib/mcp/setup-readiness';

const ENV_KEYS = [
  'O8_PACKAGED_APP',
  'O8_BUNDLED_MCP_PATH',
  'O8_CODEBASE_MEMORY_BIN',
  'CORTEX_IDE_DATA_DIR',
] as const;

let saved: Record<string, string | undefined>;
let dir: string;

function statusPath(): string {
  return join(dir, 'bin', '.codebase-memory-status');
}

function writeStatus(value: string, ageMs = 0): void {
  mkdirSync(join(dir, 'bin'), { recursive: true });
  writeFileSync(statusPath(), value);
  if (ageMs > 0) {
    const t = new Date(Date.now() - ageMs);
    utimesSync(statusPath(), t, t);
  }
}

/** Packaged shape: bundled operator server present, binary NOT downloaded. */
function packagedWithoutBinary(): void {
  const bundled = join(dir, 'operator-mcp-server.mjs');
  writeFileSync(bundled, '// bundled');
  process.env.O8_PACKAGED_APP = '1';
  process.env.O8_BUNDLED_MCP_PATH = bundled;
  process.env.CORTEX_IDE_DATA_DIR = dir;
  delete process.env.O8_CODEBASE_MEMORY_BIN;
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  dir = mkdtempSync(join(tmpdir(), 'o8-readiness-'));
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('getMcpSetupReadiness', () => {
  it('dev (not packaged) is always ready', () => {
    delete process.env.O8_PACKAGED_APP;
    expect(getMcpSetupReadiness()).toEqual({ ready: true, reason: null, detail: null, warning: null });
  });

  it('packaged without the bundled server blocks (genuine first-launch)', () => {
    process.env.O8_PACKAGED_APP = '1';
    delete process.env.O8_BUNDLED_MCP_PATH;
    const r = getMcpSetupReadiness();
    expect(r.ready).toBe(false);
    expect(r.reason).toBe('bundled_mcp_not_ready');
  });

  it('binary present → ready, no warning', () => {
    packagedWithoutBinary();
    mkdirSync(join(dir, 'bin'), { recursive: true });
    writeFileSync(join(dir, 'bin', 'codebase-memory-mcp'), 'bin');
    const r = getMcpSetupReadiness();
    expect(r).toEqual({ ready: true, reason: null, detail: null, warning: null });
  });

  it('download genuinely in flight blocks (fresh "downloading" status)', () => {
    packagedWithoutBinary();
    writeStatus('downloading');
    const r = getMcpSetupReadiness();
    expect(r.ready).toBe(false);
    expect(r.reason).toBe('codebase_memory_not_ready');
  });

  it('THE REGRESSION: failed download unblocks Connect with a warning', () => {
    packagedWithoutBinary();
    writeStatus('error');
    const r = getMcpSetupReadiness();
    expect(r.ready).toBe(true);
    expect(r.warning).toMatch(/proceeds without it/);
  });

  it('explicit empty env sentinel (Rust "unavailable" signal) unblocks', () => {
    packagedWithoutBinary();
    process.env.O8_CODEBASE_MEMORY_BIN = '';
    const r = getMcpSetupReadiness();
    expect(r.ready).toBe(true);
    expect(r.warning).not.toBeNull();
  });

  it('no status signal at all unblocks (pre-status build / dead thread)', () => {
    packagedWithoutBinary();
    const r = getMcpSetupReadiness();
    expect(r.ready).toBe(true);
    expect(r.warning).not.toBeNull();
  });

  it('a STALE "downloading" claim (crashed downloader) unblocks', () => {
    packagedWithoutBinary();
    writeStatus('downloading', 11 * 60 * 1000);
    const r = getMcpSetupReadiness();
    expect(r.ready).toBe(true);
    expect(r.warning).not.toBeNull();
  });
});
