import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const target = process.env.O8_NEXT_TARGET || 'x86_64-apple-darwin';
const output = execFileSync('cargo', ['tree', '--manifest-path', 'native/o8-next/Cargo.toml', '--locked', '--target', target,
  '--edges', 'normal,build', '--prefix', 'none', '--format', '{p}|{l}'], { encoding: 'utf8' });
const packages = new Map();
for (const line of output.trim().split('\n')) {
  const [identity, license] = line.replace(/ \(\*\)$/, '').split('|');
  const match = identity.match(/^(\S+) v(\S+)/);
  if (!match || !license) throw Error('Unrecognized package license');
  const [, name, version] = match;
  if (/GPL/i.test(license) || ['editor', 'terminal', 'markdown', 'gpuix-native'].includes(name)) throw Error(`Disallowed dependency: ${name}`);
  packages.set(`${name}@${version}`, { name, version, license });
}
if (packages.get('gpui@0.2.2')?.license !== 'Apache-2.0') throw Error('GPUI license mismatch');
writeFileSync(process.env.O8_NEXT_LICENSE_OUTPUT || 'native/o8-next/evidence/licenses.json', JSON.stringify({ target, gpui: '0.2.2', gplPackages: 0,
  note: 'Declared normal/build dependency graph. Includes permissive and MPL-2.0 transitive licenses.',
  packages: [...packages.values()].sort((a, b) => a.name.localeCompare(b.name)) }) + '\n');
console.log(`Audited ${packages.size} packages, no GPL or excluded application crates`);
