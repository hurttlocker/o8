export interface DiffFile {
  path: string;
  status: 'A' | 'M' | 'D' | 'R';
  patch: string;
}

function normalizeSectionPath(section: string) {
  const lines = section.split('\n');
  const renameTo = lines.find((line) => line.startsWith('rename to '));
  if (renameTo) {
    return renameTo.slice('rename to '.length).trim();
  }

  const plusLine = lines.find((line) => line.startsWith('+++ '));
  if (plusLine && plusLine !== '+++ /dev/null') {
    return plusLine.replace(/^\+\+\+ b\//, '').trim();
  }

  const minusLine = lines.find((line) => line.startsWith('--- '));
  if (minusLine && minusLine !== '--- /dev/null') {
    return minusLine.replace(/^--- a\//, '').trim();
  }

  const header = lines[0] ?? '';
  const match = header.match(/^diff --git a\/(.+?) b\/(.+)$/);
  return match?.[2]?.trim() ?? match?.[1]?.trim() ?? '';
}

function normalizeSectionStatus(section: string): DiffFile['status'] {
  if (section.includes('\nnew file mode ')) {
    return 'A';
  }
  if (section.includes('\ndeleted file mode ')) {
    return 'D';
  }
  if (section.includes('\nrename from ') || section.includes('\nrename to ')) {
    return 'R';
  }
  return 'M';
}

/**
 * Parse a unified git diff output into per-file entries.
 */
export function parseGitDiff(rawDiff: string): DiffFile[] {
  if (!rawDiff.trim()) {
    return [];
  }

  const sections = rawDiff
    .split(/^diff --git /m)
    .map((section, index) => index === 0 ? section : `diff --git ${section}`)
    .filter((section) => section.trim().startsWith('diff --git '));

  return sections
    .map((section) => {
      const path = normalizeSectionPath(section);
      if (!path) {
        return null;
      }
      return {
        path,
        status: normalizeSectionStatus(section),
        patch: section.trimEnd(),
      } satisfies DiffFile;
    })
    .filter((entry): entry is DiffFile => entry !== null);
}
