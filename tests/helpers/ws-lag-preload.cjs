// Isolated server fixture: inject one known CPU block; forbid external fetches.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { syncBuiltinESMExports } = require('node:module');
const root = process.env.O8_LAG_FIXTURE_DIR;
if (!root) throw new Error('Missing lag fixture directory');
const originalListen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  if (args[1] === '0.0.0.0') args[1] = '127.0.0.1';
  return originalListen.apply(this, args);
};
syncBuiltinESMExports();
const originalFetch = global.fetch;
global.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Fixture forbids external fetch');
  return originalFetch(input, init);
};
function wsLagFixtureBlock() {
  const deadline = performance.now() + 550;
  while (performance.now() < deadline) Math.sqrt(Math.random());
}
const originalInterval = global.setInterval;
global.setInterval = (callback, delay, ...args) => originalInterval(() => {
  const trigger = path.join(root, 'block-once');
  if (delay === 1000 && String(callback).includes('this.tick(') && fs.existsSync(trigger)) {
    fs.unlinkSync(trigger);
    wsLagFixtureBlock();
  }
  callback(...args);
}, delay);
