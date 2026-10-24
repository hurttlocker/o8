import { runRuleCheck, type RuleCheckGitReader, type RuleCheckResult } from './rule-check';
import { scanSpawnEnvironment } from './spawn-environment-rule';

/**
 * o8's own source rules on top of the shared checks. The spawn boundary names
 * this repository's files and needs the TypeScript compiler, so only the
 * repository's rule-check script loads it; packet gates in the app never do.
 */
export function runRepositoryRuleCheck(cwd: string, baseRef?: string, git?: RuleCheckGitReader): Promise<RuleCheckResult> {
  return runRuleCheck(cwd, baseRef, git, [scanSpawnEnvironment]);
}
