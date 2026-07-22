import type { ApprovalRisk } from '@/lib/approvals/types';
import type { LaneFileChange } from '@/lib/lane/lane-diff-facts';
import type { MergeCheckResult } from '@/lib/lane/preview-merge';
import type { PacketSelfReview } from '@/lib/orchestrator/types';

const SPOKEN_FILE_LIMIT = 4;
const FINDING_LIMIT = 5;
const RISK_FLAG_LIMIT = 5;

export type SpokenReviewVerdict = 'approved' | 'rejected' | 'unreviewed';
export type SpokenSecondPassStatus = 'not-required' | 'pending' | 'agreed' | 'blocked';
export type SpokenTestStatus = 'worker-reported-passed' | 'worker-reported-failed' | 'not-reported' | 'stale';

export interface SpokenReviewFinding {
  file: string;
  line?: number | null;
  severity: 'high' | 'warning' | 'info';
  description: string;
  resolution?: string | null;
}

export interface SpokenReviewInput {
  packetId: string;
  title: string;
  evidence: {
    headSha: string;
    fingerprint: string;
    diffBase: string;
    diffBaseWarning?: string | null;
    stat: string;
    governanceFingerprint?: string;
  };
  fileChanges: LaneFileChange[];
  review: {
    verdict: SpokenReviewVerdict;
    summary: string;
    findings: SpokenReviewFinding[];
  };
  approvalRisk?: ApprovalRisk | null;
  reviewRiskReasons?: string[];
  mergeGate: {
    verdict: 'passing' | 'failing' | 'unavailable';
    checks: MergeCheckResult[];
  };
  secondPass: {
    status: SpokenSecondPassStatus;
    detail?: string | null;
  };
  testEvidence?: {
    current: boolean;
    selfReview?: PacketSelfReview | null;
  };
}

export interface SpokenReviewBrief {
  packetId: string;
  title: string;
  evidence: SpokenReviewInput['evidence'];
  files: {
    count: number;
    touched: string[];
    omittedCount: number;
    deleted: string[];
    migrations: string[];
    apiSurface: string[];
  };
  review: SpokenReviewInput['review'] & {
    risk: ApprovalRisk | 'unknown';
    findingCount: number;
  };
  mergeGate: SpokenReviewInput['mergeGate'] & { failedChecks: string[] };
  secondPass: SpokenReviewInput['secondPass'];
  tests: {
    status: SpokenTestStatus;
    confidence?: PacketSelfReview['confidence'];
    summary?: string;
  };
  riskFlags: string[];
  spokenSummary: string;
}

function unique(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

function isMigrationPath(path: string) {
  return /(?:^|\/)(?:migrations?|schema)(?:\/|\.|$)|(?:^|\/)db(?:\/|$)/i.test(path);
}

function isApiSurfacePath(path: string) {
  return path.startsWith('src/app/api/')
    || path.startsWith('src/lib/mcp/')
    || path.startsWith('cli/src/')
    || /(?:^|\/)route\.(?:ts|tsx|js|jsx)$/i.test(path);
}

function describePaths(paths: string[]) {
  if (paths.length === 0) return '';
  const spoken = paths.slice(0, SPOKEN_FILE_LIMIT);
  const omitted = paths.length - spoken.length;
  return omitted > 0 ? `${spoken.join(', ')}, and ${omitted} more` : spoken.join(', ');
}

function deriveTestStatus(testEvidence?: SpokenReviewInput['testEvidence']): SpokenReviewBrief['tests'] {
  if (testEvidence && !testEvidence.current) {
    return { status: 'stale' };
  }
  const selfReview = testEvidence?.selfReview;
  const summary = selfReview?.summary.trim();
  const mentionsTests = summary
    ? /\b(?:tests?|vitest|jest|pytest|cargo test|typecheck|tsc)\b/i.test(summary)
    : false;
  if (!selfReview || !summary || !mentionsTests) {
    return { status: 'not-reported' };
  }
  if (/\b(?:tests?|vitest|jest|pytest|cargo test|typecheck|tsc)\b.{0,40}\b(?:not run|not executed|skipped|unknown)\b/i.test(summary)) {
    return { status: 'not-reported', summary };
  }
  const explicitlyFailed = /(?:\b(?:no|zero)\s+(?:tests?|vitest|jest|pytest|cargo test|typecheck|tsc)\b.{0,30}\b(?:passed|passing|succeeded|green)\b|\b(?:tests?|vitest|jest|pytest|cargo test|typecheck|tsc)\b.{0,40}\b(?:did not pass|do not pass|does not pass|not passing|failed|failing|failure|red)\b)/i.test(summary);
  if (explicitlyFailed) {
    return {
      status: 'worker-reported-failed',
      confidence: selfReview.confidence,
      summary,
    };
  }
  const explicitlyPassed = /(?:\b(?:tests?|vitest|jest|pytest|cargo test|typecheck|tsc)\b.{0,60}\b(?:passed|passing|green|succeeded)\b|\b(?:passed|passing)\b.{0,30}\b(?:tests?|vitest|jest|pytest|cargo test|typecheck|tsc)\b)/i.test(summary);
  if (!explicitlyPassed) return { status: 'not-reported', summary };
  return { status: 'worker-reported-passed', confidence: selfReview.confidence, summary };
}

function buildSpokenSummary(input: {
  title: string;
  files: SpokenReviewBrief['files'];
  review: SpokenReviewBrief['review'];
  mergeGate: SpokenReviewBrief['mergeGate'];
  secondPass: SpokenReviewBrief['secondPass'];
  tests: SpokenReviewBrief['tests'];
  riskFlags: string[];
}) {
  const { title, files, review, mergeGate, secondPass, tests, riskFlags } = input;
  const parts: string[] = [];
  const fileNames = files.omittedCount > 0
    ? `${files.touched.join(', ')}, and ${files.omittedCount} more`
    : describePaths(files.touched);
  parts.push(files.count === 0
    ? `${title} has no detected file changes.`
    : `${title} changes ${files.count} file${files.count === 1 ? '' : 's'}${fileNames ? `: ${fileNames}` : ''}.`);

  const surfaceNotes: string[] = [];
  if (files.deleted.length > 0) {
    surfaceNotes.push(`${files.deleted.length} deletion${files.deleted.length === 1 ? '' : 's'}`);
  }
  if (files.migrations.length > 0) {
    surfaceNotes.push(`${files.migrations.length} migration or schema path${files.migrations.length === 1 ? '' : 's'}`);
  }
  if (files.apiSurface.length > 0) {
    surfaceNotes.push(`${files.apiSurface.length} API or command surface${files.apiSurface.length === 1 ? '' : 's'}`);
  }
  if (surfaceNotes.length > 0) {
    parts.push(`The diff includes ${surfaceNotes.join(', ')}.`);
  }

  const findingCount = review.findingCount;
  if (review.verdict === 'unreviewed') {
    parts.push('The AI review has not recorded a verdict yet.');
    parts.push(`The merge gate is ${mergeGate.verdict}.`);
  } else {
    parts.push(`The AI review ${review.verdict}${findingCount === 0
      ? ' with no findings'
      : ` with ${findingCount} finding${findingCount === 1 ? '' : 's'}`} and the merge gate is ${mergeGate.verdict}.`);
  }

  if (secondPass.status !== 'not-required') {
    parts.push(`The independent second pass is ${secondPass.status}.`);
  }
  if (tests.status === 'worker-reported-passed') {
    parts.push(`The worker reports tests passed with ${tests.confidence} confidence.`);
  } else if (tests.status === 'worker-reported-failed') {
    parts.push('The worker reports verification or tests failed.');
  } else {
    parts.push(tests.status === 'stale'
      ? 'The available worker test evidence belongs to an earlier attempt or HEAD.'
      : 'No test result was recorded in the worker self-review.');
  }
  if (riskFlags.length > 0) {
    parts.push(`The main risk flag is: ${riskFlags[0]}.`);
  }
  return parts.join(' ');
}

export function buildSpokenReviewBrief(input: SpokenReviewInput): SpokenReviewBrief {
  const touched = unique(input.fileChanges.map((change) => change.path));
  const classifiedPaths = unique(input.fileChanges.flatMap((change) => (
    change.previousPath ? [change.path, change.previousPath] : [change.path]
  )));
  const deleted = unique(input.fileChanges
    .filter((change) => change.status === 'deleted')
    .map((change) => change.path));
  const migrations = classifiedPaths.filter(isMigrationPath);
  const apiSurface = classifiedPaths.filter(isApiSurfacePath);
  const failedChecks = input.mergeGate.checks
    .filter((check) => check.verdict === 'fail')
    .map((check) => check.detail ? `${check.name}: ${check.detail}` : check.name);
  const findingFlags = input.review.findings
    .filter((finding) => finding.severity !== 'info')
    .map((finding) => {
      const location = finding.line ? `${finding.file}:${finding.line}` : finding.file;
      return `${location}: ${finding.description}`;
    });
  const riskFlags = unique([
    ...(input.reviewRiskReasons ?? []),
    ...failedChecks,
    ...findingFlags,
    ...(input.secondPass.status === 'blocked' && input.secondPass.detail
      ? [`second pass: ${input.secondPass.detail}`]
      : []),
  ]).slice(0, RISK_FLAG_LIMIT);
  const files = {
    count: touched.length,
    touched: touched.slice(0, SPOKEN_FILE_LIMIT),
    omittedCount: Math.max(0, touched.length - SPOKEN_FILE_LIMIT),
    deleted,
    migrations,
    apiSurface,
  };
  const review: SpokenReviewBrief['review'] = {
    ...input.review,
    findings: input.review.findings.slice(0, FINDING_LIMIT),
    findingCount: input.review.findings.length,
    risk: input.approvalRisk ?? 'unknown',
  };
  const mergeGate = {
    ...input.mergeGate,
    failedChecks,
  };
  const tests = deriveTestStatus(input.testEvidence);
  const secondPass = input.secondPass;

  return {
    packetId: input.packetId,
    title: input.title,
    evidence: input.evidence,
    files,
    review,
    mergeGate,
    secondPass,
    tests,
    riskFlags,
    spokenSummary: buildSpokenSummary({
      title: input.title,
      files,
      review,
      mergeGate,
      secondPass,
      tests,
      riskFlags,
    }),
  };
}
