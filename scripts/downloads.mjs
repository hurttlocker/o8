#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const REPO = 'hurttlocker/o8';
const DEFAULT_COUNT = 10;
const MAX_COUNT = 100;

function fail(message) {
  console.error(`[downloads] ${message}`);
  process.exit(1);
}

function runGh(args) {
  const result = spawnSync('gh', args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error?.code === 'ENOENT') {
    fail('GitHub CLI is not installed. Install gh and run "gh auth login".');
  }
  return result;
}

const rawCount = process.argv[2];
const count = rawCount === undefined ? DEFAULT_COUNT : Number(rawCount);
if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) {
  fail(`count must be an integer from 1 to ${MAX_COUNT}.`);
}
if (process.argv.length > 3) {
  fail('usage: npm run downloads -- [count]');
}

const auth = runGh(['auth', 'status', '--hostname', 'github.com']);
if (auth.status !== 0) {
  fail('GitHub CLI is not authenticated. Run "gh auth login", then retry.');
}

const releases = [];
for (let page = 1; releases.length < count; page += 1) {
  const response = runGh(['api', `repos/${REPO}/releases?per_page=100&page=${page}`]);
  if (response.status !== 0) {
    const detail = response.stderr.trim() || `gh exited ${response.status ?? 'without a status'}`;
    fail(`GitHub API request failed: ${detail}`);
  }

  let batch;
  try {
    batch = JSON.parse(response.stdout);
  } catch {
    fail('GitHub API returned invalid JSON.');
  }
  if (!Array.isArray(batch)) {
    fail('GitHub API returned an unexpected response.');
  }
  releases.push(...batch.filter((release) => typeof release?.published_at === 'string'));
  if (batch.length < 100) break;
}

const rows = releases
  .sort((a, b) => b.published_at.localeCompare(a.published_at))
  .slice(0, count)
  .map((release) => {
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const assetSummary = assets.length > 0
      ? assets.map((asset) => `${asset.name} (${asset.download_count ?? 0})`).join(', ')
      : 'none';
    const total = assets.reduce((sum, asset) => sum + (Number(asset.download_count) || 0), 0);
    return [release.tag_name || '(untagged)', release.published_at.slice(0, 10), assetSummary, String(total)];
  });

if (rows.length === 0) {
  console.log(`[downloads] No published releases found for ${REPO}.`);
  process.exit(0);
}

const headers = ['VERSION', 'PUBLISHED', 'ASSETS (DOWNLOADS)', 'TOTAL'];
const widths = headers.map((header, index) =>
  Math.max(header.length, ...rows.map((row) => row[index].length)),
);
const render = (row) => row.map((value, index) => value.padEnd(widths[index])).join('  ').trimEnd();

console.log(render(headers));
console.log(widths.map((width) => '-'.repeat(width)).join('  '));
for (const row of rows) console.log(render(row));
