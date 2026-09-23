import { z } from 'zod';

export const MAX_PACKAGE_BYTES = 512 * 1024;
const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64);
export const skillSchema = z.object({
  name: slug,
  description: z.string().trim().min(1).max(500),
  instructions: z.string().trim().min(1).max(48 * 1024),
}).strict().refine((skill) => new TextEncoder().encode(skill.instructions).length <= 60 * 1024, 'Instructions must fit within 60 KB.');
export type SkillDraft = z.infer<typeof skillSchema>;
export const packageSchema = z.object({
  format: z.literal('o8-instructions-v1'),
  id: slug,
  name: z.string().trim().min(1).max(100),
  version: z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/).max(32),
  description: z.string().trim().min(1).max(500),
  skills: z.array(skillSchema).min(1).max(12),
}).strict().refine((entry) => new Set(entry.skills.map((skill) => skill.name)).size === entry.skills.length, 'Skill names must be unique.').refine((entry) => new TextEncoder().encode(JSON.stringify(entry)).length <= MAX_PACKAGE_BYTES - 1024, 'Package is too large.');
export type InstructionPackage = z.infer<typeof packageSchema>;
export interface DamagedPackage { id: string; message: string }
export interface InstalledPackage {
  manifest: InstructionPackage;
  enabled: boolean;
  revision: string;
  files: Array<{ name: string; file: string }>;
}
export const PROJECT_GUIDE: InstructionPackage = {
  format: 'o8-instructions-v1', id: 'project-guide', name: 'Project guide', version: '1.0.0',
  description: 'Understand a repository before changing it, then leave a clear handoff.',
  skills: [
    { name: 'project-orientation', description: 'Find project instructions, architecture, and relevant checks before starting work.', instructions: 'Read the project and repository instructions first. Identify the task scope, relevant modules, existing patterns, and verification commands. For projects with multiple repositories, identify which repository owns each change. Do not assume every repository needs an edit. Report missing context before acting on uncertain assumptions.' },
    { name: 'change-handoff', description: 'Explain what changed, how it was verified, and what still needs attention.', instructions: 'Inspect the changes and verification evidence. Summarize the resulting user behavior, affected repositories, checks run and their results, and unresolved issues. Distinguish implemented, tested, and released states. Do not claim tests or deployment succeeded without evidence. Preserve unrelated changes.' },
  ],
};

export function skillMarkdown(skill: SkillDraft): string {
  return `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${skill.instructions}\n`;
}

/** Imports instruction-only Markdown, without interpreting frontmatter as executable configuration. */
export function parseSkillMarkdown(raw: string): SkillDraft {
  if (raw.length > 64 * 1024) throw new Error('Choose a SKILL.md smaller than 64 KB.');
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw.replace(/\r\n?/g, '\n'));
  if (!match) throw new Error('SKILL.md needs name and description frontmatter followed by instructions.');
  const metadata: Record<string, string> = {};
  const lines = match[1].split('\n');
  for (let index = 0; index < lines.length; index++) {
    const field = /^(name|description):\s*(.*)$/.exec(lines[index]);
    if (!field) {
      if (lines[index].trim()) throw new Error('Only name and description are supported. Remove other frontmatter before importing.');
      continue;
    }
    if (metadata[field[1]]) throw new Error('Duplicate frontmatter fields are not supported.');
    let value = field[2].trim();
    if (/^[|>][+-]?$/.test(value)) {
      const parts: string[] = [];
      while (index + 1 < lines.length && /^\s/.test(lines[index + 1])) parts.push(lines[++index].trim());
      value = parts.join(' ');
    } else if (value.startsWith('"')) {
      try { value = JSON.parse(value); } catch { throw new Error('Invalid quoted frontmatter.'); }
    } else if (value.startsWith("'")) value = value.slice(1, -1).replace(/''/g, "'");
    metadata[field[1]] = value;
  }
  const parsed = skillSchema.safeParse({ ...metadata, instructions: match[2] });
  if (!parsed.success) throw new Error('Use a lowercase, hyphenated name, a description, and non-empty instructions.');
  return parsed.data;
}
