// Test-process instrumentation only. Keep the real WebSocket server, Git,
// filesystem, and HTTP path; shorten its ten-second timers for a bounded test.
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const { syncBuiltinESMExports } = require('node:module');

const root = process.env.O8_REVIEW_TEST_DIR;
if (!root) throw new Error('Missing isolated review test directory');
const setIntervalOriginal = global.setInterval;
global.setInterval = (callback, delay, ...args) => setIntervalOriginal(callback, delay === 10_000 ? 200 : delay, ...args);

const execFileOriginal = cp.execFile;
cp.execFile = function (file, args, options, callback) {
  const reviewDiff = file === 'sh' && args?.[1]?.startsWith('git diff --shortstat');
  if (!reviewDiff) return execFileOriginal.apply(this, arguments);
  fs.appendFileSync(path.join(root, 'diff-calls.jsonl'), `${JSON.stringify({ cwd: options.cwd })}\n`);
  return execFileOriginal.call(this, file, args, options, (error, stdout, stderr) => {
    if (!fs.existsSync(path.join(root, 'hold-diff'))) return callback(error, stdout, stderr);
    fs.writeFileSync(path.join(root, 'diff-held'), 'ready');
    const deadline = Date.now() + 5_000;
    const finish = () => {
      if (Date.now() < deadline && fs.existsSync(path.join(root, 'hold-diff'))) {
        setTimeout(finish, 20);
      } else {
        callback(error, stdout, stderr);
      }
    };
    finish();
  });
};
cp.execFile[promisify.custom] = (file, args, options) => new Promise((resolve, reject) => {
  cp.execFile(file, args, options, (error, stdout, stderr) => {
    if (error) reject(Object.assign(error, { stdout, stderr }));
    else resolve({ stdout, stderr });
  });
});
syncBuiltinESMExports();
