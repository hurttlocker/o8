import { describe, expect, it } from 'vitest';

import {
  buildServeLaunchAgentPlist,
  decideServeLogRotation,
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
});
