export interface PullAuthor {
  login?: string;
  isBot?: boolean;
}

export interface CreditLookups {
  pullAuthors: Map<number, PullAuthor>;
  permissionFor(login: string): string;
}

/** Pull request number → credited GitHub login. */
export type ContributorCredits = Record<number, string>;

export function pullNumberFromSubject(subject: unknown): number | null;
export function resolveContributorCredits(pullNumbers: Iterable<number>, lookups: CreditLookups): ContributorCredits;
export function contributorCreditLine(credits: ContributorCredits | null | undefined): string;
export function ghCreditLookups(
  repo: string,
  options?: { since?: string; run?: (args: string[]) => string },
): CreditLookups;
export function creditsForSubjects(subjects: string[], lookups: CreditLookups): ContributorCredits;
