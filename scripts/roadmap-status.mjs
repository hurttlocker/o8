#!/usr/bin/env node
// Read-only roadmap status. Reads every open issue labeled `tracking`, counts the
// checkboxes in its `## Checklist` section, and prints a table. Never writes ROADMAP.md.
// Requires the GitHub CLI (`gh`) to be installed and authenticated.
import { execFileSync } from 'node:child_process';

const REPO = process.env.ROADMAP_REPO || 'hurttlocker/o8';

function gh(path) {
  const out = execFileSync('gh', ['api', '--paginate', '-H', 'Accept: application/vnd.github+json', path], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  // --paginate concatenates JSON arrays; splice them back into one array.
  return JSON.parse(`[${out.trim().replace(/^\[/, '').replace(/\]$/, '').replace(/\]\s*\[/g, ',')}]`);
}

// The last `## Checklist` section wins, so a converted epic's comment beats its body.
function countChecklist(texts) {
  let checked = 0;
  let total = 0;
  for (const text of texts) {
    if (!text || !/^##\s+Checklist\s*$/m.test(text)) continue;
    const section = text.split(/^##\s+Checklist\s*$/m).pop().split(/^##\s+/m)[0];
    let c = 0;
    let t = 0;
    for (const line of section.split('\n')) {
      const m = /^\s*-\s*\[([ xX])\]/.exec(line);
      if (!m) continue;
      t += 1;
      if (m[1] !== ' ') c += 1;
    }
    if (t > 0) {
      checked = c;
      total = t;
    }
  }
  return { checked, total };
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s.slice(0, n - 1) + ' ' : s + ' '.repeat(n - s.length);
}

const issues = gh(`repos/${REPO}/issues?state=open&labels=tracking&per_page=100`).filter((i) => !i.pull_request);
if (issues.length === 0) {
  console.log('No open issues labeled `tracking`.');
  process.exit(0);
}

const rows = [];
for (const issue of issues) {
  const texts = [issue.body || ''];
  if (issue.comments > 0) {
    for (const c of gh(`repos/${REPO}/issues/${issue.number}/comments?per_page=100`)) texts.push(c.body || '');
  }
  const { checked, total } = countChecklist(texts);
  const pct = total > 0 ? Math.round((checked / total) * 20) * 5 : null;
  rows.push({ number: issue.number, title: issue.title, checked, total, pct });
}
rows.sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1) || a.number - b.number);

console.log(`${pad('ISSUE', 7)}${pad('TITLE', 52)}${pad('SHIPPED', 10)}PERCENT`);
console.log('-'.repeat(76));
for (const r of rows) {
  const shipped = r.total > 0 ? `${r.checked}/${r.total}` : 'none';
  const pct = r.pct === null ? 'no checklist' : `${r.pct}%`;
  console.log(`${pad('#' + r.number, 7)}${pad(r.title, 52)}${pad(shipped, 10)}${pct}`);
}
const done = rows.reduce((a, r) => a + r.checked, 0);
const all = rows.reduce((a, r) => a + r.total, 0);
console.log('-'.repeat(76));
console.log(`${rows.length} tracking issues, ${done} of ${all} children shipped.`);
