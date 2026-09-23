import { constants, closeSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CustomizeError, listPackages } from './storage';
import { skillMarkdown } from './packages';

/** Return reviewed managed instructions, or a bounded skill from an inventoried agent root. */
export function readSkillInstructions(repo: string | null, requested: string): string {
  if (!path.isAbsolute(requested) || requested.split(path.sep).includes('..')) throw new CustomizeError('invalid_file', 'Invalid skill file.');
  const packages = [null, ...(repo ? [repo] : [])].flatMap(listPackages);
  for (const entry of packages.filter((item) => item.enabled)) {
    const file = entry.files.find((item) => item.file === requested);
    if (file) return skillMarkdown(entry.manifest.skills.find((item) => item.name === file.name)!);
  }
  const home = realpathSync(os.homedir());
  const roots = [
    ...['.o8', '.agents', '.codex', '.claude', '.gemini'].map((source) => ({ base: home, folder: path.join(home, source, 'skills') })),
    ...(repo ? ['.agents', '.claude'].map((source) => ({ base: repo, folder: path.join(repo, source, 'skills') })) : []),
  ];
  for (const { base, folder } of roots) {
    if (!requested.startsWith(`${folder}${path.sep}`)) continue;
    const root = realpathSync(folder);
    const file = realpathSync(requested);
    if (!root.startsWith(`${base}${path.sep}`) || !file.startsWith(`${root}${path.sep}`) || path.basename(file) !== 'SKILL.md') continue;
    const relative = path.relative(root, file).split(path.sep);
    if (relative.length !== 2) continue;
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > 64 * 1024) throw new CustomizeError('invalid_file', 'Skill file must be smaller than 64 KB.');
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { return readFileSync(fd, 'utf8'); } finally { closeSync(fd); }
  }
  throw new CustomizeError('invalid_file', 'This skill is unavailable in the selected scope. Refresh the library.', 403);
}
