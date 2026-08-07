import { describe, expect, it } from 'vitest';
import { cliCandidates, directoryOnPath, windowsShimContents } from './install.js';

// #1741 (part of #1673): the o8 CLI has no Windows shim/PATH story yet. These
// tests cover the pure win32 branches with injected platform/home/PATH
// inputs so the Windows logic has real coverage running on macOS CI, per the
// port-audit-windows.md direction to process.platform-gate rather than
// assume a POSIX shell.
describe('cliCandidates', () => {
  it('returns a single .cmd candidate under <home>/.o8/bin on win32', () => {
    expect(cliCandidates('win32', 'C:\\Users\\me')).toEqual(['C:\\Users\\me\\.o8\\bin\\o8.cmd']);
  });

  it('keeps the existing darwin/linux candidate list unchanged', () => {
    expect(cliCandidates('linux', '/home/me')).toEqual(['/usr/local/bin/o8', '/home/me/.local/bin/o8']);
  });
});

describe('directoryOnPath', () => {
  it('splits on ; and compares case-insensitively on win32', () => {
    const pathEnv = 'C:\\Windows;C:\\Users\\me\\.o8\\bin;C:\\Windows\\System32';
    expect(directoryOnPath('C:\\Users\\me\\.o8\\bin\\o8.cmd', pathEnv, 'win32')).toBe(true);
    expect(directoryOnPath('c:\\users\\me\\.o8\\bin\\o8.cmd', pathEnv, 'win32')).toBe(true);
  });

  it('ignores a trailing backslash on win32 PATH entries', () => {
    const pathEnv = 'C:\\Users\\me\\.o8\\bin\\';
    expect(directoryOnPath('C:\\Users\\me\\.o8\\bin\\o8.cmd', pathEnv, 'win32')).toBe(true);
  });

  it('returns false when the win32 directory is absent', () => {
    expect(directoryOnPath('C:\\Users\\me\\.o8\\bin\\o8.cmd', 'C:\\Windows', 'win32')).toBe(false);
  });

  it('splits on : for POSIX platforms', () => {
    const pathEnv = '/usr/bin:/usr/local/bin:/home/me/.local/bin';
    expect(directoryOnPath('/usr/local/bin/o8', pathEnv, 'linux')).toBe(true);
    expect(directoryOnPath('/opt/o8/bin/o8', pathEnv, 'linux')).toBe(false);
  });
});

describe('windowsShimContents', () => {
  it('generates a .cmd that forwards to the resolved source with CRLF line endings', () => {
    const { cmd } = windowsShimContents('C:\\Users\\me\\.o8\\bin\\o8.mjs');
    expect(cmd).toContain('"%NODE_BIN%" "C:\\Users\\me\\.o8\\bin\\o8.mjs" %*');
    expect(cmd).toContain('\r\n');
    expect(cmd).not.toMatch(/[^\r]\n/);
  });

  it('emits no .ps1 — one would shadow the .cmd and fail the default execution policy', () => {
    // PowerShell resolves a bare `o8` to a sibling .ps1 before the .cmd, and an
    // unsigned .ps1 is refused on a stock Windows install ("running scripts is
    // disabled on this system"), so `o8 --version` died there while `o8.cmd
    // --version` worked. Shipping only the .cmd lets PATHEXT reach it from both
    // shells. Verified in a Windows 11 VM, 2026-08-06.
    const shim = windowsShimContents('C:\\Users\\me\\.o8\\bin\\o8.mjs') as Record<string, unknown>;
    expect(shim.ps1).toBeUndefined();
    expect(Object.keys(shim)).toEqual(['cmd']);
  });
});
