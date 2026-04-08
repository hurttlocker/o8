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

function toFrontmatter(directive: Directive): string {
  const lines = [
    '---',
    `id: ${directive.id}`,
    `title: ${directive.title}`,
    `scope: ${directive.scope}`,
  ];
  if (directive.repoName) {
    lines.push(`repoName: ${directive.repoName}`);
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
    if (!meta.id) return null;
    return {
      id: meta.id,
      title: meta.title || 'Untitled',
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

export function buildDirectiveBlock(repoName?: string | null): DirectiveBlock {
  const directives = getDirectivesForScope(repoName);
  if (directives.length === 0) {
    return { text: '', tokenEstimate: 0, directiveCount: 0 };
  }

  const sections: string[] = [];
  let totalChars = 0;
  const charBudget = MAX_DIRECTIVE_TOKENS * TOKEN_ESTIMATE_DIVISOR;

  for (const d of directives) {
    if (totalChars + d.content.length > charBudget) break;
    const scopeLabel = d.scope === 'global' ? 'Global' : `Repo: ${d.repoName}`;
    sections.push(`## ${d.title} [${scopeLabel}]\n\n${d.content}`);
    totalChars += d.content.length;
  }

  const text = `<o8-directives>\n${sections.join('\n\n---\n\n')}\n</o8-directives>`;
  return {
    text,
    tokenEstimate: Math.ceil(text.length / TOKEN_ESTIMATE_DIVISOR),
    directiveCount: sections.length,
  };
}
