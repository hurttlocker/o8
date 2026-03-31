// Hide the empty sprint-6 pipeline verification commits from repo-truth review surfaces.
const FILTERED_RECENT_COMMIT_HASHES = new Set([
  '72c59d6e05356b4c6767edea3a523619012368fa',
  '468caa67d7bef322ad814b02e1b89f85acb550f5',
]);

const FILTERED_RECENT_COMMIT_SUBJECTS = new Set([
  'Merge lane: test: pipeline e2e verification',
  'test: pipeline e2e verification',
]);

export function parseRecentCommits(raw: string, limit = 5): string[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [fullHash, shortHash, ...subjectParts] = line.split('\t');
      const subject = subjectParts.join('\t').trim();
      if (!fullHash || !shortHash || !subject) {
        return null;
      }
      if (FILTERED_RECENT_COMMIT_HASHES.has(fullHash) || FILTERED_RECENT_COMMIT_SUBJECTS.has(subject)) {
        return null;
      }
      return `${shortHash} ${subject}`;
    })
    .filter((line): line is string => line !== null)
    .slice(0, limit);
}
