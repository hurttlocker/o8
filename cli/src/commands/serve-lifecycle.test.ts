import { describe, expect, it } from 'vitest';

import {
  buildServeLaunchAgentPlist,
  decideServeSupervisorRetry,
  decideServeLogRotation,
  formatServeLogSessionBoundary,
  formatServeSupervisorFailure,
  SERVE_LAUNCH_AGENT_LABEL,
  SERVE_LOG_ROTATE_BYTES,
  SERVE_PREVIOUS_LOG_TRUNCATE_BYTES,
} from './serve-lifecycle';

describe('serve launch agent lifecycle', () => {
  it('generates the per-user plist with the daemon entry, data paths, and crash restart policy', () => {
    const plist = buildServeLaunchAgentPlist({
      cliEntry: '/Applications/o8.app/Contents/Resources/server/bin/o8.mjs',
      dataDir: '/Users/operator/Library/Application Support/o8 & data',
      logPath: '/Users/operator/.o8/logs/serve.log',
      nodePath: '/opt/node/bin/node',
      workingDirectory: '/Applications/o8.app/Contents/Resources/server',
    });

    expect(plist).toContain(`<string>${SERVE_LAUNCH_AGENT_LABEL}</string>`);
    expect(plist).toContain('<key>ProgramArguments</key>');
    expect(plist).toContain('<string>/opt/node/bin/node</string>');
    expect(plist).toContain('<string>/Applications/o8.app/Contents/Resources/server/bin/o8.mjs</string>');
    expect(plist).toContain('<string>__launch_agent</string>');
    expect(plist).toContain('/Users/operator/Library/Application Support/o8 &amp; data');
    expect(plist).toContain('<key>KeepAlive</key>');
    expect(plist).toContain('<key>SuccessfulExit</key>\n    <false/>');
    expect(plist.match(/<string>\/Users\/operator\/\.o8\/logs\/serve\.log<\/string>/g)).toHaveLength(2);
  });

  it('rotates only an oversized current log and truncates only an oversized previous log', () => {
    expect(decideServeLogRotation(SERVE_LOG_ROTATE_BYTES, SERVE_PREVIOUS_LOG_TRUNCATE_BYTES)).toEqual({
      rotateCurrent: false,
      truncatePrevious: false,
    });
    expect(decideServeLogRotation(SERVE_LOG_ROTATE_BYTES + 1, SERVE_PREVIOUS_LOG_TRUNCATE_BYTES + 1)).toEqual({
      rotateCurrent: true,
      truncatePrevious: true,
    });
    expect(decideServeLogRotation(null, null)).toEqual({
      rotateCurrent: false,
      truncatePrevious: false,
    });
  });

  it('formats a readable boundary for each daemon session', () => {
    expect(formatServeLogSessionBoundary('2026-08-31T13:00:00.000Z', '0.1.723', 4242)).toBe(
      '\n=== o8 serve session 2026-08-31T13:00:00.000Z version=0.1.723 pid=4242 ===\n',
    );
  });

  it('backs off consecutive pre-ready failures and stops after the fifth', () => {
    expect([1, 2, 3, 4, 5].map(decideServeSupervisorRetry)).toEqual([
      { delayMs: 1_000, exhausted: false },
      { delayMs: 2_000, exhausted: false },
      { delayMs: 4_000, exhausted: false },
      { delayMs: 8_000, exhausted: false },
      { delayMs: 0, exhausted: true },
    ]);
    expect(formatServeSupervisorFailure('2026-08-31T14:00:00.000Z', 5)).toBe(
      '=== o8 serve supervisor 2026-08-31T14:00:00.000Z exiting after 5 consecutive daemon failures before ready; launchd will retry ===\n',
    );
  });
});
