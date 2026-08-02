export const RAW_BRIEF = `You are implementing a real issue in this repository from a clean checkout
at the commit where the issue was still open.

Produce the best first diff you can: correct, minimal, and fit for this codebase.
Repository instructions at the root are binding. Implement every requirement without
expanding the requested scope. You have one turn and the fixed time budget enforced by
the runner. You may inspect, implement, test, and repair within that turn.

Leave the work uncommitted. Do not commit, push, create branches, or alter benchmark
artifacts. Do not weaken or rewrite tests to make the implementation pass.`;

export const JUDGE_PROMPT = `You are an impartial senior code reviewer scoring candidate diffs for the
same issue. You do not know which runtime or treatment produced them. Judge only the
code and base repository; do not speculate about authorship.

Mechanical checks are reported separately and do not affect the score. Find what a
compiler cannot establish: unreachable behavior, omitted requirements, excess public
surface, unnecessary refactors, weak error paths, and state leaking across scopes.

Score each candidate 0-10 as the mean of four equally weighted sub-scores:
  correctness      - does it satisfy every issue requirement on the real code path?
  scopeDiscipline  - is every changed unit necessary, with no omitted requirement?
  robustness       - are failure paths and state boundaries handled correctly?
  fit              - does it match the surrounding code and architecture?

Do not reward length or brevity by itself. A smaller diff wins only when coverage and
correctness are equal. Review only; do not edit the repository.

Write only a JSON array to the requested output file, one object per candidate:
[{"blindLabel":"A","subScores":{"correctness":0,"scopeDiscipline":0,"robustness":0,"fit":0},"mostSeriousDefect":"..."}]`;
