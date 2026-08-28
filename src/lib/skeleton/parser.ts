/**
 * Skeleton Map — Regex-based signature extraction.
 *
 * Extracts top-level definitions (functions, classes, interfaces, types,
 * enums, consts) from TypeScript/TSX files using regex patterns.
 *
 * Designed so Tree-sitter can replace the regex internals later
 * without changing the public interface.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { FileSkeleton, SkeletonSymbol, SupportedLanguage, SymbolKind } from './types';

const MAX_SIGNATURE_LEN = 200;

// ── Hashing ──

export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function hashFile(absolutePath: string): string {
  const content = readFileSync(absolutePath, 'utf-8');
  return hashContent(content);
}

// ── TypeScript / TSX parser ──

interface PatternDef {
  pattern: RegExp;
  kind: SymbolKind;
  exported: boolean;
  /** Index of the capture group containing the name. */
  nameGroup: number;
}

/**
 * Regex patterns for TypeScript top-level definitions.
 * Each runs line-by-line against the source.
 */
const TS_PATTERNS: PatternDef[] = [
  // Exported declarations
  { pattern: /^export\s+(?:async\s+)?function\s+(\w+)/, kind: 'function', exported: true, nameGroup: 1 },
  { pattern: /^export\s+class\s+(\w+)/, kind: 'class', exported: true, nameGroup: 1 },
  { pattern: /^export\s+interface\s+(\w+)/, kind: 'interface', exported: true, nameGroup: 1 },
  { pattern: /^export\s+type\s+(\w+)/, kind: 'type', exported: true, nameGroup: 1 },
  { pattern: /^export\s+enum\s+(\w+)/, kind: 'enum', exported: true, nameGroup: 1 },
  { pattern: /^export\s+const\s+(\w+)/, kind: 'const', exported: true, nameGroup: 1 },
  // export default function/class
  { pattern: /^export\s+default\s+(?:async\s+)?function\s+(\w+)/, kind: 'function', exported: true, nameGroup: 1 },
  { pattern: /^export\s+default\s+class\s+(\w+)/, kind: 'class', exported: true, nameGroup: 1 },
  // Non-exported top-level declarations
  { pattern: /^(?:async\s+)?function\s+(\w+)/, kind: 'function', exported: false, nameGroup: 1 },
  { pattern: /^class\s+(\w+)/, kind: 'class', exported: false, nameGroup: 1 },
  { pattern: /^interface\s+(\w+)/, kind: 'interface', exported: false, nameGroup: 1 },
  { pattern: /^type\s+(\w+)/, kind: 'type', exported: false, nameGroup: 1 },
  { pattern: /^enum\s+(\w+)/, kind: 'enum', exported: false, nameGroup: 1 },
  { pattern: /^const\s+(\w+)/, kind: 'const', exported: false, nameGroup: 1 },
];

/** Pattern to detect import statements. */
const IMPORT_PATTERN = /^import\s+.*\s+from\s+['"]([^'"]+)['"]/;

/** Detect class method definitions (inside class body). */
const METHOD_PATTERNS: PatternDef[] = [
  { pattern: /^\s+(?:async\s+)?(\w+)\s*\(/, kind: 'method', exported: false, nameGroup: 1 },
  { pattern: /^\s+(?:static\s+)?(?:async\s+)?(\w+)\s*\(/, kind: 'method', exported: false, nameGroup: 1 },
  { pattern: /^\s+(?:get|set)\s+(\w+)\s*\(/, kind: 'property', exported: false, nameGroup: 1 },
];

function truncateSignature(line: string): string {
  // Take up to the opening brace or end of line
  let sig = line.trimEnd();
  const braceIdx = sig.indexOf('{');
  if (braceIdx > 0) {
    sig = sig.slice(0, braceIdx).trimEnd();
  }
  if (sig.length > MAX_SIGNATURE_LEN) {
    sig = sig.slice(0, MAX_SIGNATURE_LEN - 3) + '...';
  }
  return sig;
}

function parseTypeScript(content: string): { symbols: SkeletonSymbol[]; imports: string[] } {
  const lines = content.split('\n');
  const symbols: SkeletonSymbol[] = [];
  const imports: string[] = [];
  const seenNames = new Set<string>();

  let currentClass: string | null = null;
  let braceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();

    // Track brace depth for class body detection
    for (const ch of line) {
      if (ch === '{') braceDepth++;
      if (ch === '}') braceDepth--;
    }

    // Reset class context when we exit its body
    if (currentClass && braceDepth <= 0) {
      currentClass = null;
    }

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
      continue;
    }

    // Imports
    const importMatch = trimmed.match(IMPORT_PATTERN);
    if (importMatch) {
      imports.push(importMatch[1]);
      continue;
    }

    // Top-level definitions (only at depth 0 or 1)
    if (braceDepth <= 1) {
      let matched = false;
      for (const def of TS_PATTERNS) {
        const m = trimmed.match(def.pattern);
        if (m) {
          const name = m[def.nameGroup];
          const key = `${def.kind}:${name}:${def.exported}`;
          if (!seenNames.has(key)) {
            seenNames.add(key);
            symbols.push({
              name,
              kind: def.kind,
              line: i + 1,
              signature: truncateSignature(trimmed),
              exported: def.exported,
            });
            // Track if we entered a class
            if (def.kind === 'class') {
              currentClass = name;
            }
          }
          matched = true;
          break;
        }
      }

      // Methods inside a class body
      if (!matched && currentClass && braceDepth === 1) {
        for (const def of METHOD_PATTERNS) {
          const m = trimmed.match(def.pattern);
          if (m) {
            const name = m[def.nameGroup];
            // Skip constructor, common JS keywords
            if (name === 'if' || name === 'for' || name === 'while' || name === 'switch' || name === 'return' || name === 'try' || name === 'catch') continue;
            const key = `method:${currentClass}.${name}`;
            if (!seenNames.has(key)) {
              seenNames.add(key);
              symbols.push({
                name,
                kind: def.kind,
                line: i + 1,
                signature: truncateSignature(trimmed),
                exported: false,
                parent: currentClass,
              });
            }
            break;
          }
        }
      }
    }
  }

  return { symbols, imports };
}

// ── Rust parser ──

const RUST_PATTERNS: PatternDef[] = [
  { pattern: /^pub\s+(?:async\s+)?fn\s+(\w+)/, kind: 'function', exported: true, nameGroup: 1 },
  { pattern: /^pub\s+struct\s+(\w+)/, kind: 'class', exported: true, nameGroup: 1 },
  { pattern: /^pub\s+enum\s+(\w+)/, kind: 'enum', exported: true, nameGroup: 1 },
  { pattern: /^pub\s+trait\s+(\w+)/, kind: 'interface', exported: true, nameGroup: 1 },
  { pattern: /^pub\s+type\s+(\w+)/, kind: 'type', exported: true, nameGroup: 1 },
  { pattern: /^pub\s+mod\s+(\w+)/, kind: 'const', exported: true, nameGroup: 1 },
  { pattern: /^(?:async\s+)?fn\s+(\w+)/, kind: 'function', exported: false, nameGroup: 1 },
  { pattern: /^struct\s+(\w+)/, kind: 'class', exported: false, nameGroup: 1 },
  { pattern: /^enum\s+(\w+)/, kind: 'enum', exported: false, nameGroup: 1 },
  { pattern: /^trait\s+(\w+)/, kind: 'interface', exported: false, nameGroup: 1 },
  { pattern: /^impl\s+(?:<[^>]*>\s*)?(\w+)/, kind: 'class', exported: false, nameGroup: 1 },
];

function parseRust(content: string): { symbols: SkeletonSymbol[]; imports: string[] } {
  const lines = content.split('\n');
  const symbols: SkeletonSymbol[] = [];
  const imports: string[] = [];
  const seenNames = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    if (!trimmed || trimmed.startsWith('//')) continue;

    // use statements
    if (trimmed.startsWith('use ')) {
      const path = trimmed.replace(/^use\s+/, '').replace(/;.*$/, '').trim();
      imports.push(path);
      continue;
    }

    for (const def of RUST_PATTERNS) {
      const m = trimmed.match(def.pattern);
      if (m) {
        const name = m[def.nameGroup];
        const key = `${def.kind}:${name}:${def.exported}`;
        if (!seenNames.has(key)) {
          seenNames.add(key);
          symbols.push({
            name,
            kind: def.kind,
            line: i + 1,
            signature: truncateSignature(trimmed),
            exported: def.exported,
          });
        }
        break;
      }
    }
  }

  return { symbols, imports };
}

// ── JSON parser (package.json, tsconfig.json) ──

function parseJSON(content: string, relativePath: string): { symbols: SkeletonSymbol[]; imports: string[] } {
  const symbols: SkeletonSymbol[] = [];
  const fileName = relativePath.split('/').pop() ?? '';

  try {
    const parsed = JSON.parse(content);

    if (fileName === 'package.json') {
      if (parsed.name) {
        symbols.push({ name: parsed.name, kind: 'const', line: 1, signature: `name: "${parsed.name}"`, exported: true });
      }
      if (parsed.scripts) {
        for (const key of Object.keys(parsed.scripts).slice(0, 10)) {
          symbols.push({ name: key, kind: 'function', line: 1, signature: `script: ${key}`, exported: true });
        }
      }
      if (parsed.dependencies) {
        symbols.push({ name: 'dependencies', kind: 'const', line: 1, signature: `${Object.keys(parsed.dependencies).length} packages`, exported: true });
      }
    } else if (fileName === 'tsconfig.json') {
      if (parsed.compilerOptions) {
        const keys = Object.keys(parsed.compilerOptions).slice(0, 8);
        symbols.push({ name: 'compilerOptions', kind: 'const', line: 1, signature: `{ ${keys.join(', ')} }`, exported: true });
      }
    }
  } catch {
    // Invalid JSON — skip
  }

  return { symbols, imports: [] };
}

// ── Markdown parser (extract headings) ──

function parseMarkdown(content: string): { symbols: SkeletonSymbol[]; imports: string[] } {
  const lines = content.split('\n');
  const symbols: SkeletonSymbol[] = [];

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,3})\s+(.+)/);
    if (match) {
      symbols.push({
        name: match[2].trim(),
        kind: 'heading',
        line: i + 1,
        signature: lines[i].trim(),
        exported: true,
      });
    }
  }

  return { symbols, imports: [] };
}

// ── Public API ──

/**
 * Parse a single file and return its skeleton.
 * Reads the file from disk, computes hash, extracts symbols.
 */
export function parseFile(absolutePath: string, relativePath: string, language: SupportedLanguage): FileSkeleton {
  const content = readFileSync(absolutePath, 'utf-8');
  const contentHash = hashContent(content);
  const lineCount = content.split('\n').length;

  let result: { symbols: SkeletonSymbol[]; imports: string[] };

  switch (language) {
    case 'typescript':
    case 'tsx':
      result = parseTypeScript(content);
      break;
    case 'rust':
      result = parseRust(content);
      break;
    case 'json':
      result = parseJSON(content, relativePath);
      break;
    case 'markdown':
      result = parseMarkdown(content);
      break;
    default:
      result = { symbols: [], imports: [] };
  }

  return {
    relativePath,
    language,
    symbols: result.symbols,
    imports: result.imports,
    lineCount,
    contentHash,
  };
}
