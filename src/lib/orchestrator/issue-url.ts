/**
 * deriveGithubIssueUrl — reconstruct a GitHub issue URL from a packet's
 * referenceLabel (e.g. `#608` or `608`) plus a repo remoteUrl.
 *
 * Returns null when either input is missing or unparseable, or when the
 * remoteUrl isn't a GitHub host. Used by PacketCard to enable the "open"
 * action pill when a packet hasn't cached `issue.url` yet.
 */

const ISSUE_LABEL_PATTERN = /^#?(\d+)$/;
const GIT_SSH_PATTERN = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/;
const HTTPS_PATTERN = /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/;

export function deriveGithubIssueUrl(
  referenceLabel: string | null | undefined,
  remoteUrl: string | null | undefined,
): string | null {
  if (!referenceLabel || !remoteUrl) return null;

  const labelMatch = referenceLabel.trim().match(ISSUE_LABEL_PATTERN);
  if (!labelMatch) return null;
  const number = labelMatch[1];

  const trimmed = remoteUrl.trim();
  let owner: string | null = null;
  let repo: string | null = null;

  const sshMatch = trimmed.match(GIT_SSH_PATTERN);
  if (sshMatch) {
    owner = sshMatch[1];
    repo = sshMatch[2];
  } else {
    const httpsMatch = trimmed.match(HTTPS_PATTERN);
    if (httpsMatch) {
      owner = httpsMatch[1];
      repo = httpsMatch[2];
    }
  }

  if (!owner || !repo) return null;
  return `https://github.com/${owner}/${repo}/issues/${number}`;
}
