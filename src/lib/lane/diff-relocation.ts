import { execFileSync } from 'node:child_process';

interface DiffFileContent {
  file: string;
  isNew: boolean;
  addedHunks: string[][];
  deletedHunks: string[][];
}

const SHINGLE_SIZE = 3;
const MIN_RELOCATED_LINES = 5;
const MIN_HUNK_SIMILARITY = 0.6;

function parseDiffPath(value: string): string | null {
  const path = value.trim();
  if (!path || path === '/dev/null') return null;
  return path.startsWith('b/') ? path.slice(2) : path;
}

function normalizeLine(line: string): string {
  return line.trim().replace(/\s+/g, ' ');
}

function shingleKey(lines: string[], start: number): string | null {
  const window = lines.slice(start, start + SHINGLE_SIZE).map(normalizeLine);
  if (window.length !== SHINGLE_SIZE) return null;

  const substantive = window.filter(Boolean);
  const signalLength = substantive.join('').replace(/[^a-zA-Z0-9_$]/g, '').length;
  if (substantive.length < 2 || signalLength < 20) return null;
  return JSON.stringify(window);
}

function parseDiffContent(diff: string): DiffFileContent[] {
  const files: DiffFileContent[] = [];
  let current: DiffFileContent | null = null;
  let oldFileMissing = false;
  let addedHunk: string[] | null = null;
  let deletedHunk: string[] | null = null;

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = null;
      oldFileMissing = false;
      addedHunk = null;
      deletedHunk = null;
      continue;
    }
    if (line.startsWith('@@')) {
      if (!current) continue;
      addedHunk = [];
      deletedHunk = [];
      current.addedHunks.push(addedHunk);
      current.deletedHunks.push(deletedHunk);
      continue;
    }
    if (current && addedHunk && deletedHunk) {
      if (line.startsWith('+')) addedHunk.push(line.slice(1));
      else if (line.startsWith('-')) deletedHunk.push(line.slice(1));
      continue;
    }
    if (line.startsWith('--- ')) {
      oldFileMissing = line.slice(4).trim() === '/dev/null';
      continue;
    }
    if (line.startsWith('+++ ')) {
      const file = parseDiffPath(line.slice(4));
      if (!file) continue;
      current = { file, isNew: oldFileMissing, addedHunks: [], deletedHunks: [] };
      files.push(current);
      continue;
    }
  }

  return files;
}

function buildNewFileShingles(files: DiffFileContent[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const file of files) {
    if (!file.isNew) continue;
    for (const hunk of file.addedHunks) {
      for (let index = 0; index <= hunk.length - SHINGLE_SIZE; index += 1) {
        const key = shingleKey(hunk, index);
        if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }
  return counts;
}

function relocatedLinesInHunk(hunk: string[], available: Map<string, number>): number {
  const matchedIndexes = new Set<number>();
  const localUsage = new Map<string, number>();

  for (let index = 0; index <= hunk.length - SHINGLE_SIZE; index += 1) {
    const key = shingleKey(hunk, index);
    if (!key || (localUsage.get(key) ?? 0) >= (available.get(key) ?? 0)) continue;
    localUsage.set(key, (localUsage.get(key) ?? 0) + 1);
    for (let offset = 0; offset < SHINGLE_SIZE; offset += 1) matchedIndexes.add(index + offset);
  }

  const substantiveLines = hunk.filter((line) => normalizeLine(line).length > 0).length;
  const matchedSubstantiveLines = [...matchedIndexes]
    .filter((index) => normalizeLine(hunk[index] ?? '').length > 0)
    .length;
  if (
    matchedSubstantiveLines < MIN_RELOCATED_LINES
    || matchedSubstantiveLines / Math.max(1, substantiveLines) < MIN_HUNK_SIMILARITY
  ) {
    return 0;
  }

  for (const [key, used] of localUsage) {
    available.set(key, Math.max(0, (available.get(key) ?? 0) - used));
  }
  return matchedIndexes.size;
}

/**
 * Credit exact code relocated from an existing file into a newly-added file.
 * Credits are conservative: a deleted hunk must be mostly composed of matching
 * three-line sequences, and each target sequence can be consumed only once.
 */
export function getRelocatedDeletionCredits(cwd: string, baseBranch: string): Map<string, number> {
  try {
    const diff = execFileSync('git', ['diff', '--unified=0', '--no-color', '--no-ext-diff', `${baseBranch}...HEAD`], {
      windowsHide: true,
      cwd,
      timeout: 15_000,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });
    const files = parseDiffContent(diff);
    const available = buildNewFileShingles(files);
    const credits = new Map<string, number>();

    if (available.size === 0) return credits;
    for (const file of files) {
      if (file.isNew) continue;
      const relocated = file.deletedHunks.reduce(
        (total, hunk) => total + relocatedLinesInHunk(hunk, available),
        0,
      );
      if (relocated > 0) credits.set(file.file, relocated);
    }
    return credits;
  } catch {
    return new Map();
  }
}
