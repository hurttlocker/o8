import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  claimDashTmuxSessionForCurrentProfile,
  createDashTmuxSessionSync,
  dashTmuxDataProfileTag,
} from '@/lib/ws-server/dash-terminal-persistence';

const tmuxAvailable = process.platform !== 'win32' && (() => {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

function input(sessionName: string) {
  return {
    enabled: true,
    sessionName,
    cols: 120,
    rows: 30,
    cwd: '/tmp',
    shell: '/bin/sh',
    env: process.env,
  };
}

describe.runIf(tmuxAvailable)('dashboard tmux data-profile ownership through real tmux', () => {
  it('keeps profile B out of profile A GC inputs and reclaims A after restart', () => {
    const dataProfileA = mkdtempSync(join(tmpdir(), 'o8-tmux-profile-a-'));
    const dataProfileB = mkdtempSync(join(tmpdir(), 'o8-tmux-profile-b-'));
    const serverName = `o8-profile-test-${process.pid}-${Date.now()}`;
    const sessionNameA = `cortex-dash-profile-${process.pid}-${Date.now()}`;
    const sessionNameB = `${sessionNameA}-b`;
    const listFormat = '#{session_name}\t#{session_created}\t#{@o8_dashboard_data_profile}';
    vi.stubEnv('O8_DASH_TMUX_SERVER_NAME', serverName);
    vi.stubEnv('O8_DATA_DIR', dataProfileA);
    vi.stubEnv('CORTEX_IDE_DATA_DIR', dataProfileA);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      expect(createDashTmuxSessionSync(input(sessionNameA))).toBe(true);

      vi.stubEnv('O8_DATA_DIR', dataProfileB);
      vi.stubEnv('CORTEX_IDE_DATA_DIR', dataProfileB);
      expect(claimDashTmuxSessionForCurrentProfile(sessionNameA, false)).toBe(false);
      expect(createDashTmuxSessionSync(input(sessionNameB))).toBe(true);

      vi.stubEnv('O8_DATA_DIR', dataProfileA);
      vi.stubEnv('CORTEX_IDE_DATA_DIR', dataProfileA);
      const profileAGcInputs = String(execFileSync('tmux', ['-L', serverName, 'list-sessions', '-F', listFormat]))
        .trim()
        .split('\n')
        .map((line) => line.split('\t'))
        .filter(([, , profileTag]) => profileTag === dashTmuxDataProfileTag())
        .map(([name]) => name);
      expect(profileAGcInputs).toEqual([sessionNameA]);
      expect(claimDashTmuxSessionForCurrentProfile(sessionNameA, false)).toBe(true);
    } finally {
      try { execFileSync('tmux', ['-L', serverName, 'kill-server'], { stdio: 'ignore' }); } catch {}
      rmSync(dataProfileA, { recursive: true, force: true });
      rmSync(dataProfileB, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  });
});
