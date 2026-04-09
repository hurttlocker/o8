/**
 * Directive Store — CRUD over ~/.cortex-ide/directives/ flat files.
 *
 * Each directive is a markdown file with YAML frontmatter.
 * SQLite is NOT used for storage — files on disk are the source of truth.
 * This keeps directives diffable, version-controllable, and portable.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Directive, CreateDirectiveInput, UpdateDirectiveInput, DirectiveBlock } from './directives-types';

const DATA_DIR = process.env.CORTEX_IDE_DATA_DIR || path.join(process.env.HOME || '', '.cortex-ide');
const DIRECTIVES_DIR = path.join(DATA_DIR, 'directives');

function ensureDirectivesDir(): void {
  if (!fs.existsSync(DIRECTIVES_DIR)) {
    fs.mkdirSync(DIRECTIVES_DIR, { recursive: true });
  }
}

// ── YAML frontmatter parser (minimal, no dependency) ──

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon > 0) {
      const key = line.slice(0, colon).trim();
      const val = line.slice(colon + 1).trim();
      meta[key] = val;
    }
  }
  return { meta, body: match[2].trim() };
}

/**
 * Escape a value for single-line YAML frontmatter.
 *
 * Replaces any `\r` or `\n` with a space, and breaks up any `---` sequence
 * so a malicious or pasted value can't close the frontmatter block and inject
 * new fields or pollute the body. See BUG #19/#20 — title with embedded
 * newlines used to corrupt the file and silently change scope on roundtrip.
 */
function escapeFrontmatterValue(raw: string): string {
  return raw.replace(/[\r\n]+/g, ' ').replace(/---+/g, '- - -');
}

function toFrontmatter(directive: Directive): string {
  const lines = [
    '---',
    `id: ${directive.id}`,
    `title: ${escapeFrontmatterValue(directive.title)}`,
    `scope: ${directive.scope}`,
  ];
  if (directive.repoName) {
    lines.push(`repoName: ${escapeFrontmatterValue(directive.repoName)}`);
  }
  lines.push(
    `priority: ${directive.priority}`,
    `created: ${directive.createdAt}`,
    `updated: ${directive.updatedAt}`,
    '---',
    '',
    directive.content,
  );
  return lines.join('\n');
}

function fileToDirective(filePath: string): Directive | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const { meta, body } = parseFrontmatter(raw);
    // A directive with no id or no title is corrupt — skip it rather than
    // silently masquerade as "Untitled". See BUG #14.
    if (!meta.id || !meta.title) return null;
    return {
      id: meta.id,
      title: meta.title,
      scope: (meta.scope === 'global' ? 'global' : 'repo') as Directive['scope'],
      repoName: meta.repoName || null,
      priority: parseInt(meta.priority || '50', 10),
      content: body,
      createdAt: meta.created || new Date().toISOString(),
      updatedAt: meta.updated || new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

// ── CRUD ──

export function listDirectives(): Directive[] {
  ensureDirectivesDir();
  const files = fs.readdirSync(DIRECTIVES_DIR).filter((f) => f.endsWith('.md'));
  const directives: Directive[] = [];
  for (const file of files) {
    const d = fileToDirective(path.join(DIRECTIVES_DIR, file));
    if (d) directives.push(d);
  }
  directives.sort((a, b) => a.priority - b.priority);
  return directives;
}

export function getDirective(id: string): Directive | null {
  ensureDirectivesDir();
  const filePath = path.join(DIRECTIVES_DIR, `${id}.md`);
  if (!fs.existsSync(filePath)) return null;
  return fileToDirective(filePath);
}

export function createDirective(input: CreateDirectiveInput): Directive {
  ensureDirectivesDir();
  const now = new Date().toISOString();
  const directive: Directive = {
    id: `d-${Date.now()}-${randomUUID().slice(0, 8)}`,
    title: input.title,
    scope: input.scope,
    repoName: input.repoName ?? null,
    priority: input.priority ?? 50,
    content: input.content,
    createdAt: now,
    updatedAt: now,
  };
  const filePath = path.join(DIRECTIVES_DIR, `${directive.id}.md`);
  fs.writeFileSync(filePath, toFrontmatter(directive), 'utf-8');
  return directive;
}

export function updateDirective(id: string, input: UpdateDirectiveInput): Directive | null {
  const existing = getDirective(id);
  if (!existing) return null;
  const updated: Directive = {
    ...existing,
    title: input.title ?? existing.title,
    scope: input.scope ?? existing.scope,
    repoName: input.repoName !== undefined ? input.repoName : existing.repoName,
    priority: input.priority ?? existing.priority,
    content: input.content ?? existing.content,
    updatedAt: new Date().toISOString(),
  };
  const filePath = path.join(DIRECTIVES_DIR, `${id}.md`);
  fs.writeFileSync(filePath, toFrontmatter(updated), 'utf-8');
  return updated;
}

export function deleteDirective(id: string): boolean {
  const filePath = path.join(DIRECTIVES_DIR, `${id}.md`);
  if (!fs.existsSync(filePath)) return false;
  fs.unlinkSync(filePath);
  return true;
}

// ── Query ──

export function getDirectivesForScope(repoName?: string | null): Directive[] {
  const all = listDirectives();
  return all.filter((d) => {
    if (d.scope === 'global') return true;
    if (d.scope === 'repo' && d.repoName === repoName) return true;
    return false;
  });
}

// ── Injection ──

const TOKEN_ESTIMATE_DIVISOR = 4;
const MAX_DIRECTIVE_TOKENS = 1500;

const WRAPPER_OPEN = '<o8-directives>\n';
const WRAPPER_CLOSE = '\n</o8-directives>';
const SECTION_SEPARATOR = '\n\n---\n\n';

export function buildDirectiveBlock(repoName?: string | null): DirectiveBlock {
  const directives = getDirectivesForScope(repoName);
  if (directives.length === 0) {
    return { text: '', tokenEstimate: 0, directiveCount: 0 };
  }

  const charBudget = MAX_DIRECTIVE_TOKENS * TOKEN_ESTIMATE_DIVISOR;
  // Reserve overhead up front: wrapper tags are always present, separators are
  // added between sections, and each section has a `## {title} [{scope}]\n\n`
  // header. Previously the loop only counted content length, so the rendered
  // block blew past the token budget (see Finding #18).
  const wrapperOverhead = WRAPPER_OPEN.length + WRAPPER_CLOSE.length;

  const sections: string[] = [];
  let totalChars = wrapperOverhead;

  for (const d of directives) {
    const scopeLabel = d.scope === 'global' ? 'Global' : `Repo: ${d.repoName}`;
    const section = `## ${d.title} [${scopeLabel}]\n\n${d.content}`;
    const separatorChars = sections.length > 0 ? SECTION_SEPARATOR.length : 0;
    if (totalChars + section.length + separatorChars > charBudget) break;
    sections.push(section);
    totalChars += section.length + separatorChars;
  }

  const text = `${WRAPPER_OPEN}${sections.join(SECTION_SEPARATOR)}${WRAPPER_CLOSE}`;
  return {
    text,
    tokenEstimate: Math.ceil(text.length / TOKEN_ESTIMATE_DIVISOR),
    directiveCount: sections.length,
  };
}
