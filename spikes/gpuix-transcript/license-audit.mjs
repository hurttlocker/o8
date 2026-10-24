import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
const target = 'x86_64-apple-darwin';
const text = execFileSync('cargo', ['+1.97.1', 'tree', '--manifest-path', 'pure-gpui/Cargo.toml', '--locked',
  '--target', target, '--edges', 'normal,build', '--prefix', 'none', '--format', '{p}|{l}'], { encoding: 'utf8' });
const unique = new Map();
for (const line of text.trim().split('\n')) {
  const [identity, license] = line.replace(/ \(\*\)$/, '').split('|');
  const match = identity.match(/^(\S+) v(\S+)/);
  if (!match) throw Error('Unrecognized cargo tree record');
  const [, name, version] = match;
  if (/GPL/i.test(license) || ['editor', 'terminal', 'markdown', 'gpuix-native'].includes(name)) throw Error(`Disallowed dependency: ${name}`);
  unique.set(`${name}@${version}`, { name, version, license });
}
const packages = [...unique.values()].sort((a, b) => a.name.localeCompare(b.name));
if (packages.find(p => p.name === 'gpui')?.license !== 'Apache-2.0') throw Error('GPUI license mismatch');
await writeFile('results/pure-license-audit.json', JSON.stringify({ target, edgeKinds: ['normal', 'build'],
  gpuiVersion: '0.2.2', gpuiLicense: 'Apache-2.0', gplPackages: 0, copiedApplicationCrates: 0,
  note: 'Declared licenses for the linked macOS graph, including build tools. Transitive licenses include permissive and MPL-2.0 packages; not every dependency is Apache-only.',
  packages }, null, 2) + '\n');
console.log(`Audited ${packages.length} linked/build packages; no GPL or excluded application crates`);
