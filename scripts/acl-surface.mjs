#!/usr/bin/env node
/**
 * Resolved-ACL surface dump — the security proof artifact.
 *
 * Capabilities are the webview's security boundary, so any change to them (even a
 * pure-performance one) has to prove that the RESOLVED PERMISSION SURFACE is
 * unchanged. The file layout is not the surface: what matters is, for each
 * window, exactly which permissions it holds and which remote origins may talk to
 * it. Six capability files or three is an implementation detail; the surface is
 * the invariant.
 *
 * This reads Tauri's OWN generated artifact (src-tauri/gen/schemas/capabilities.json,
 * regenerated on every build) rather than reconstructing it from the source files,
 * and projects it to that surface, normalised and sorted so a diff is meaningful:
 *
 *   <window> :
 *     permissions: [ ...sorted... ]
 *     remote:      [ ...sorted... ]
 *
 * Usage:
 *   node scripts/acl-surface.mjs                 # print the surface
 *   node scripts/acl-surface.mjs > before.txt    # capture, change caps, rebuild
 *   diff before.txt after.txt                    # MUST be empty
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const generated = join(root, 'src-tauri', 'gen', 'schemas', 'capabilities.json');

const caps = JSON.parse(readFileSync(generated, 'utf-8'));

/** window -> { permissions: Set, remote: Set } */
const surface = new Map();

for (const cap of Object.values(caps)) {
  const windows = cap.windows ?? [];
  const permissions = (cap.permissions ?? []).map((p) =>
    typeof p === 'string' ? p : JSON.stringify(p, Object.keys(p).sort()),
  );
  const remote = (cap.remote?.urls ?? []).slice();

  for (const win of windows) {
    if (!surface.has(win)) surface.set(win, { permissions: new Set(), remote: new Set() });
    const entry = surface.get(win);
    for (const p of permissions) entry.permissions.add(p);
    for (const r of remote) entry.remote.add(r);
  }
}

const out = [];
for (const win of [...surface.keys()].sort()) {
  const { permissions, remote } = surface.get(win);
  out.push(`${win}:`);
  out.push('  permissions:');
  for (const p of [...permissions].sort()) out.push(`    - ${p}`);
  out.push('  remote:');
  for (const r of [...remote].sort()) out.push(`    - ${r}`);
}
console.log(out.join('\n'));
