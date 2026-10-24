import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

function ruleUnits(text) {
  return text.replace(/^---\n[\s\S]*?\n---\n/, '').trim().split(/\n\s*\n/)
    .filter((paragraph) => !paragraph.startsWith('#'))
    .flatMap((paragraph) => paragraph.split(/\n(?=- )/));
}

function canonicalRule(text, file) {
  // Only this locator slot may differ. Its surrounding privacy and history
  // clauses remain part of the same original rule digest.
  const portable = text.replace(/(For issues and pull requests, load )(?:`[^`]+`|\[[^\]]+\]\([^)]+\))( once\.)/g,
    '$1<github-standard>$2');
  const links = portable.replace(/\[([^\n]+?)\]\(([^)]+)\)/g, (_match, label, target) => {
    const resolved = /^[a-z]+:/.test(target)
      ? target : path.posix.normalize(path.posix.join(path.posix.dirname(file), target)).replace(/\/$/, '');
    return `[${label}](${resolved})`;
  });
  return links.replace(/\s+/g, ' ').trim();
}

/** Hashes preserve the old rules without loading a duplicate instruction file. */
export function checkAgentRules(root, baselineFile) {
  const manifest = JSON.parse(readFileSync(path.join(root, 'scripts/agent-rule-coverage.json'), 'utf8'));
  const errors = [];
  if (manifest.schema !== 'o8/agent-rule-coverage/v1') errors.push('Unknown coverage schema.');
  if (manifest.rules.length !== manifest.baseline.ruleCount) errors.push('Baseline rule count changed.');
  const core = readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  const bytes = Buffer.byteLength(core);
  if (bytes >= 2000) errors.push(`AGENTS.md is ${bytes} bytes; it must be under 2000.`);

  if (baselineFile) {
    const baseline = readFileSync(baselineFile, 'utf8');
    const units = ruleUnits(baseline);
    if (sha256(baseline) !== manifest.baseline.sha256
      || Buffer.byteLength(baseline) !== manifest.baseline.bytes
      || units.length !== manifest.baseline.ruleCount) errors.push('Original AGENTS.md does not match the baseline.');
    for (const [index, unit] of units.entries()) {
      const rule = manifest.rules[index];
      if (!rule || sha256(canonicalRule(unit, 'AGENTS.md')) !== rule.sourceSha256) {
        errors.push(`Original rule R${String(index + 1).padStart(2, '0')} is not accounted for.`);
      }
    }
  }

  const documents = new Map();
  const documentTexts = new Map();
  const ids = new Set();
  for (const rule of manifest.rules) {
    if (ids.has(rule.id)) errors.push(`Duplicate rule ${rule.id}.`);
    ids.add(rule.id);
    if (rule.sourceSha256 !== rule.sha256) {
      errors.push(`${rule.id}: rule changed beyond portable reference normalization.`);
    }
    if (rule.destination !== 'AGENTS.md' && !/^\.agents\/skills\/[a-z0-9-]+\/SKILL\.md$/.test(rule.destination)) {
      errors.push(`${rule.id}: invalid rule destination.`);
      continue;
    }
    if (!documents.has(rule.destination)) {
      try {
        const text = readFileSync(path.join(root, rule.destination), 'utf8');
        documentTexts.set(rule.destination, text);
        if (rule.destination !== 'AGENTS.md') {
          const frontmatter = text.match(/^---\n([\s\S]*?)\n---\n/);
          const name = path.posix.basename(path.posix.dirname(rule.destination));
          if (!frontmatter || !frontmatter[1].split('\n').includes(`name: ${name}`)
            || !/^description: \S.+$/m.test(frontmatter[1])) errors.push(`${rule.destination}: missing name or trigger description.`);
          if (!core.includes(`](${rule.destination})`)) errors.push(`${rule.destination}: missing core route.`);
        }
        documents.set(rule.destination, new Set(ruleUnits(text).map((unit) => sha256(canonicalRule(unit, rule.destination)))));
      } catch {
        errors.push(`${rule.destination}: missing or unreadable rule document.`);
        documents.set(rule.destination, new Set());
      }
    }
    if (rule.id === 'R22') {
      const locator = documentTexts.get(rule.destination)?.match(/For issues and pull requests, load \[[^\]]+\]\(([^)]+)\) once\./);
      if (!locator || path.posix.normalize(path.posix.join(path.posix.dirname(rule.destination), locator[1]))
        !== 'docs/operations/github-operating-standard.md') errors.push('R22: incorrect portable GitHub standard locator.');
    }
    if (!documents.get(rule.destination).has(rule.sha256)) errors.push(`${rule.id}: missing or changed in ${rule.destination}.`);
  }
  return { ok: errors.length === 0, bytes, rules: manifest.rules.length, skills: documents.size - 1, errors };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const rootIndex = args.indexOf('--root');
  const baselineIndex = args.indexOf('--baseline-file');
  try {
    const result = checkAgentRules(rootIndex >= 0 ? path.resolve(args[rootIndex + 1]) : process.cwd(),
      baselineIndex >= 0 ? path.resolve(args[baselineIndex + 1]) : undefined);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`Agent rule check failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
