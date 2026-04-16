import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);
const COMMAND_MAX_BUFFER = 10 * 1024 * 1024;
const FILE_CEILING = 800;
const MAX_VIOLATIONS_REPORTED = 60;

export type RuleId =
  | 'className'
  | 'css-shorthand'
  | 'rgba-white'
  | 'emoji'
  | 'icon-library'
  | 'file-ceiling'
  | 'hardcoded-port'
  | 'hardcoded-home-path';

export interface RuleViolation {
  file: string;
  line: number;
  rule: RuleId;
  detail: string;
}

export interface RuleCheckResult {
  ok: boolean;
  violations: RuleViolation[];
  scannedFiles: number;
}

// Layout orchestrators, multiplexers, and verb dispatchers that are explicitly
// waived from the 800-line ceiling (mirrors CLAUDE.md "ALWAYS respect the
// 800-line file ceiling" carve-outs). New entries require a user decision,
// not a code change slipped under the radar.
const CEILING_WAIVERS: ReadonlySet<string> = new Set([
  'src/app/dashboard/page.tsx',
  'src/ws-server.ts',
  'src/lib/worktree/manager.ts',
  'src/lib/lane/commands.ts',
]);

// Directories we never scan. Agent worktrees can contain these even on feature
// branches if a build ran.
const SKIP_PREFIXES: readonly string[] = [
  'node_modules/',
  '.next/',
  '.next-dev/',
  'out/',
  'dist/',
  'build/',
  'src-tauri/target/',
  'src-tauri/gen/',
  '.cortex-worktrees/',
];

function shouldCheckFile(relPath: string): boolean {
  if (SKIP_PREFIXES.some((prefix) => relPath.startsWith(prefix))) return false;
  if (relPath.includes('/generated/')) return false;
  if (relPath.endsWith('.d.ts')) return false;
  if (relPath.endsWith('.test.ts') || relPath.endsWith('.test.tsx')) return false;
  return relPath.endsWith('.tsx') || relPath.endsWith('.ts');
}

async function listTouchedFiles(cwd: string, baseRef: string): Promise<string[] | null> {
  // Agents commonly leave files uncommitted at completion — the supervisor
  // auto-commits after verification passes. So we need both committed diffs
  // against the base ref AND untracked files in the working tree to get a
  // complete picture of what the agent touched.
  const collected = new Set<string>();
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['diff', '--name-only', '--diff-filter=ACMR', baseRef],
      { cwd, maxBuffer: COMMAND_MAX_BUFFER },
    );
    for (const entry of stdout.split('\n')) {
      const trimmed = entry.trim();
      if (trimmed) collected.add(trimmed);
    }
  } catch {
    return null;
  }

  try {
    const { stdout } = await execFileAsync(
      'git',
      ['ls-files', '--others', '--exclude-standard'],
      { cwd, maxBuffer: COMMAND_MAX_BUFFER },
    );
    for (const entry of stdout.split('\n')) {
      const trimmed = entry.trim();
      if (trimmed) collected.add(trimmed);
    }
  } catch {
    // Untracked listing is best-effort; the diff output is the primary source.
  }

  return [...collected];
}

export async function runRuleCheck(cwd: string, baseRef = 'main'): Promise<RuleCheckResult> {
  const touched = await listTouchedFiles(cwd, baseRef);
  if (!touched) {
    // Fail-open: if git can't resolve the base branch, skip the check cleanly
    // rather than blocking every dispatch. The typecheck gate is still in
    // place above us.
    return { ok: true, violations: [], scannedFiles: 0 };
  }

  const filtered = touched.filter(shouldCheckFile);
  if (filtered.length === 0) {
    return { ok: true, violations: [], scannedFiles: 0 };
  }

  const violations: RuleViolation[] = [];
  let scanned = 0;

  for (const relPath of filtered) {
    if (violations.length >= MAX_VIOLATIONS_REPORTED) break;
    const absPath = join(cwd, relPath);
    let content: string;
    try {
      content = await readFile(absPath, 'utf-8');
    } catch {
      continue;
    }
    scanned += 1;

    scanFileContent(relPath, content, violations);
  }

  return {
    ok: violations.length === 0,
    violations,
    scannedFiles: scanned,
  };
}

function scanFileContent(relPath: string, content: string, violations: RuleViolation[]): void {
  // Split on \n then drop the trailing empty entry for files that end with a
  // newline so our line count matches wc -l. Without this a 800-line file ending
  // in \n reports 801 lines and trips the ceiling rule on its own.
  const rawLines = content.split('\n');
  const lines = rawLines.length > 0 && rawLines[rawLines.length - 1] === ''
    ? rawLines.slice(0, -1)
    : rawLines;

  if (!CEILING_WAIVERS.has(relPath) && lines.length > FILE_CEILING) {
    violations.push({
      file: relPath,
      line: lines.length,
      rule: 'file-ceiling',
      detail: `File is ${lines.length} lines (max ${FILE_CEILING}). Decompose before shipping — extract hooks, subcomponents, or types first.`,
    });
  }

  const isTsx = relPath.endsWith('.tsx');
  const isDesktopComponent = relPath.startsWith('src/components/desktop/');

  for (let i = 0; i < lines.length; i += 1) {
    if (violations.length >= MAX_VIOLATIONS_REPORTED) break;
    const line = lines[i];
    const lineNum = i + 1;

    // Skip pure comment lines. Rough but cheap.
    const trimmed = line.trimStart();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

    if (isTsx && /\bclassName\s*=/.test(line)) {
      violations.push({
        file: relPath,
        line: lineNum,
        rule: 'className',
        detail: 'Use inline style={{...}} instead of className. CSS classes break iOS Safari reliability — see CLAUDE.md.',
      });
    }

    const shorthandMatch = line.match(/\b(padding|margin)\s*:\s*(['"])([^'"]*)\2/);
    if (shorthandMatch) {
      const value = shorthandMatch[3].trim();
      if (/\s/.test(value)) {
        violations.push({
          file: relPath,
          line: lineNum,
          rule: 'css-shorthand',
          detail: `Use longhand ${shorthandMatch[1]}Top / ${shorthandMatch[1]}Left instead of ${shorthandMatch[1]}: '${value}'. React 19 warns on mixed shorthand/longhand.`,
        });
      }
    }

    if (/rgba\s*\(\s*255\s*,\s*255\s*,\s*255/.test(line)) {
      violations.push({
        file: relPath,
        line: lineNum,
        rule: 'rgba-white',
        detail: `Use var(--t-panel) / var(--t-bg-card) / var(--t-input-bg) instead of hardcoded rgba white values. Midnight theme turns these into gray blobs — see commit 929ffdf.`,
      });
    }

    if (/\p{Extended_Pictographic}/u.test(line)) {
      violations.push({
        file: relPath,
        line: lineNum,
        rule: 'emoji',
        detail: 'No emoji. Use raw SVG from @phosphor-icons/react/dist/defs/ or an icon token. Emoji break text rendering on iOS Safari.',
      });
    }

    if (isDesktopComponent) {
      const iconImport = line.match(/from\s+['"](lucide-react|@phosphor-icons\/react(?!\/dist\/defs)[^'"]*)['"]/);
      if (iconImport) {
        violations.push({
          file: relPath,
          line: lineNum,
          rule: 'icon-library',
          detail: `Import raw SVG path data from @phosphor-icons/react/dist/defs/ instead of ${iconImport[1]}. Neither lucide-react nor @phosphor-icons/react render correctly in the Tauri webview.`,
        });
      }
    }

    const portMatch = line.match(/\b(?:localhost|127\.0\.0\.1):?\s*300[12]\b|:\s*300[12]\b/);
    if (portMatch) {
      const ctx = line;
      // Allowlist the legitimate reasons a 3001/3002 literal is OK:
      // env fallbacks, helper functions, CORS origin arrays, dev scripts.
      const isAllowed =
        /process\.env\./.test(ctx) ||
        /O8_(?:API|WS)_PORT/i.test(ctx) ||
        /resolvePortInfo|getApiBase|resolveApiBase/i.test(ctx) ||
        /fallback|default/i.test(ctx) ||
        /lsof -ti :/i.test(ctx) ||
        /api-port|ws-port/i.test(ctx) ||
        /allowedOrigins|Access-Control|\bcors\b|\borigin\b/i.test(ctx);
      if (!isAllowed) {
        violations.push({
          file: relPath,
          line: lineNum,
          rule: 'hardcoded-port',
          detail: 'Use getApiBase() / resolveApiBase() / O8_API_PORT env. Tauri picks ports dynamically at startup — hardcoding 3001/3002 breaks packaged installs.',
        });
      }
    }

    if (/\/Users\/marquisehurtt/.test(line)) {
      violations.push({
        file: relPath,
        line: lineNum,
        rule: 'hardcoded-home-path',
        detail: 'Use os.homedir() / process.env.HOME / process.cwd() / CORTEX_IDE_DATA_DIR instead of hardcoded paths — every leak breaks fresh clones.',
      });
    }
  }
}

export function buildRuleCheckFailureMessage(result: RuleCheckResult): string {
  const grouped = new Map<string, RuleViolation[]>();
  for (const v of result.violations) {
    const existing = grouped.get(v.file);
    if (existing) {
      existing.push(v);
    } else {
      grouped.set(v.file, [v]);
    }
  }

  const sections: string[] = [
    'Post-completion rule check failed. These are mechanical invariants — every violation is a user-visible bug waiting to ship.',
    '',
    `Violations (${result.violations.length}) across ${grouped.size} file(s):`,
    '',
  ];

  for (const [file, fileViolations] of grouped) {
    sections.push(`**${file}**`);
    for (const v of fileViolations) {
      sections.push(`- L${v.line} [${v.rule}] ${v.detail}`);
    }
    sections.push('');
  }

  if (result.violations.length >= MAX_VIOLATIONS_REPORTED) {
    sections.push(`(report capped at ${MAX_VIOLATIONS_REPORTED} violations — fix these first, then re-run the checker)`);
    sections.push('');
  }

  sections.push(
    'Fix each violation, re-verify locally (`npm run rule-check`), then report completion again.',
    '',
    'The platform enforces these rules mechanically because multi-constraint holding is where weaker models drop rules — CLAUDE.md invariants are not optional.',
  );

  return sections.join('\n');
}
