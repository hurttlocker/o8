import { resolveAttributedCommitMessage } from '@/lib/lane/commit-attribution';
import { git, type GitCommandRunner } from '@/lib/lane/worktree-merge-git';

interface CandidateCommit {
  sha: string;
  subject: string;
}

export type GovernedMergeHistoryPlan =
  | { kind: 'preserve' }
  | { kind: 'squash'; commitMessage: string }
  | { kind: 'refuse'; note: string };

function isWipSubject(subject: string): boolean {
  return /^wip\s*:/i.test(subject.trim().replace(/^[*_`]+/, ''));
}

async function candidateCommits(input: {
  cwd: string;
  baseRef: string;
  candidateRef: string;
  runGit: GitCommandRunner;
}): Promise<CandidateCommit[]> {
  const { stdout } = await input.runGit(input.cwd, [
    'log',
    '--format=%H%x1f%s%x1e',
    `${input.baseRef}..${input.candidateRef}`,
  ], { timeout: 5000 });
  return stdout
    .split('\x1e')
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha = '', subject = ''] = record.split('\x1f');
      return { sha, subject };
    });
}

export async function resolveGovernedMergeHistoryPlan(input: {
  cwd: string;
  baseRef: string;
  candidateRef: string;
  commitMessage?: string;
  runGit?: GitCommandRunner;
}): Promise<GovernedMergeHistoryPlan> {
  const explicitMessage = input.commitMessage?.trim();
  if (explicitMessage) {
    return {
      kind: 'squash',
      commitMessage: resolveAttributedCommitMessage(explicitMessage),
    };
  }

  const commits = await candidateCommits({ ...input, runGit: input.runGit ?? git });
  const wipCommits = commits.filter((commit) => isWipSubject(commit.subject));
  if (wipCommits.length === 0) return { kind: 'preserve' };

  const finalCommit = commits.find((commit) => !isWipSubject(commit.subject));
  if (finalCommit) {
    return {
      kind: 'squash',
      commitMessage: resolveAttributedCommitMessage(finalCommit.subject),
    };
  }

  const wipCommit = wipCommits[0]!;
  return {
    kind: 'refuse',
    note: `Merge refused: packet history has no non-wip subject for squash. Commit ${wipCommit.sha.slice(0, 12)} is named "${wipCommit.subject}". Supply commitMessage and retry.`,
  };
}
