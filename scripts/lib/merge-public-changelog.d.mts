export interface PublicChangelogAddition {
  date: string;
  hash: string;
  line: string;
}

export function mergePublicChangelog(
  existingMarkdown: string,
  additions: PublicChangelogAddition[],
): string;
