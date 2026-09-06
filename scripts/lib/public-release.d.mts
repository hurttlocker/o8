export interface PublicReleaseCommit {
  sha: string;
  subject: string;
}

export interface PublicReleaseSection {
  title: string;
  items: string[];
}

export interface LatestShip {
  schemaVersion: 1;
  version: string;
  tag: string;
  publishedAt: string;
  title: string;
  summary: string;
  releaseUrl: string;
  sourceCommits: string[];
  sections: PublicReleaseSection[];
}

export function scrubPublicText(value: unknown): string | null;
export function parseReleaseNotes(markdown: string): string[];
export function buildLatestShip(input: {
  version: string;
  tag: string;
  publishedAt: string;
  releaseUrl: string;
  commits: PublicReleaseCommit[];
  notesMarkdown?: string;
}): LatestShip;
