// Diagnostic preload for the Windows Port Build (#1745): the webpack compile
// fails there on EACCES scandir errors walking the user profile through
// junction loops, and the walk does NOT reproduce on macOS. The port-build
// workflow injects this via NODE_OPTIONS --require on the Windows job only;
// it prints one stack per top-level home entry read outside the repo. Remove
// once the walker is identified and fixed.
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const REPO = process.cwd();
const seen = new Set();

function report(kind, target) {
  try {
    const t = String(target);
    if (!t.startsWith(HOME)) return;
    if (t.startsWith(REPO)) return;
    // one report per first-level dir under HOME to keep output readable
    const rel = t.slice(HOME.length + 1);
    const top = rel.split(path.sep)[0] || '(home root)';
    if (seen.has(top)) return;
    seen.add(top);
    const stack = new Error().stack.split('\n').slice(2, 12).join('\n');
    process.stderr.write(`\n[fs-trace] ${kind} outside repo: ${t}\n${stack}\n`);
  } catch { /* never break the build */ }
}

const origReaddirSync = fs.readdirSync;
fs.readdirSync = function (p, ...rest) { report('readdirSync', p); return origReaddirSync.call(this, p, ...rest); };
const origReaddir = fs.readdir;
fs.readdir = function (p, ...rest) { report('readdir', p); return origReaddir.call(this, p, ...rest); };
const origPReaddir = fs.promises.readdir;
fs.promises.readdir = function (p, ...rest) { report('promises.readdir', p); return origPReaddir.call(this, p, ...rest); };
