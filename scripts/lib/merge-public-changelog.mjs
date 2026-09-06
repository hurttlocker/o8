#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';

export function mergePublicChangelog(existingMarkdown, additions) {
  const lines = existingMarkdown.replace(/\s+$/, '').split(/\r?\n/);
  const firstSection = lines.findIndex((line) => /^## \d{4}-\d{2}-\d{2}$/.test(line));
  const preamble = firstSection === -1 ? lines : lines.slice(0, firstSection);
  const sections = new Map();
  let currentDate = null;

  for (const line of firstSection === -1 ? [] : lines.slice(firstSection)) {
    const header = line.match(/^## (\d{4}-\d{2}-\d{2})$/);
    if (header) {
      currentDate = header[1];
      if (!sections.has(currentDate)) sections.set(currentDate, []);
      continue;
    }
    if (currentDate) sections.get(currentDate).push(line);
  }

  const existingHashes = new Set(
    existingMarkdown.match(/^- `([a-f0-9]+)` /gmi)?.map((line) => line.match(/`([a-f0-9]+)`/i)[1]) ?? [],
  );
  const alreadySynced = (hash) => [...existingHashes]
    .some((existingHash) => hash.startsWith(existingHash) || existingHash.startsWith(hash));
  const insertedByDate = new Map();
  for (const addition of additions) {
    if (alreadySynced(addition.hash)) continue;
    const block = sections.get(addition.date) ?? [];
    const insertAt = block.findIndex((line) => /^- `/.test(line));
    const inserted = insertedByDate.get(addition.date) ?? 0;
    block.splice((insertAt === -1 ? block.length : insertAt) + inserted, 0, addition.line);
    sections.set(addition.date, block);
    insertedByDate.set(addition.date, inserted + 1);
    existingHashes.add(addition.hash);
  }

  const output = [...preamble];
  for (const date of [...sections.keys()].sort().reverse()) {
    while (output.at(-1) === '') output.pop();
    output.push('', `## ${date}`, '');
    const block = sections.get(date);
    while (block[0] === '') block.shift();
    while (block.at(-1) === '') block.pop();
    output.push(...block);
  }
  return `${output.join('\n')}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [existingPath, additionsPath, outputPath] = process.argv.slice(2);
  if (!existingPath || !additionsPath || !outputPath) {
    console.error('usage: merge-public-changelog.mjs <existing> <additions.json> <output>');
    process.exit(1);
  }
  const existing = readFileSync(existingPath, 'utf8');
  const additions = readFileSync(additionsPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [date, hash, ...entry] = line.split('\t');
      return { date, hash, line: entry.join('\t') };
    });
  writeFileSync(outputPath, mergePublicChangelog(existing, additions));
}
