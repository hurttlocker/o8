# Runtime dogfood receipt, 2026-08-10

This is one bounded operational run, not a benchmark. On August 10, 2026, o8 `0.1.666` dispatched OpenCode 2 with OpenRouter's DeepSeek V4 Flash to build automatic worker-pane placement inside o8 itself.

- **Scope:** three source/test files; rendering, lifecycle, runtime routing, and rail UI excluded.
- **Worker run:** 3m 36s, 41,312 input tokens, 5,718 output tokens, 503,808 cache-read tokens, and `$0.021491` reported cost.
- **Result:** the worker committed the three-file first pass. Independent review found an incorrect split-direction calculation and weak tests, then corrected them; 14 focused tests, TypeScript, and the changed-file rule check pass.
- **Guardrail receipt:** o8 stopped the worker before an unnecessary dependency install and preserved its commit for review. The result is useful work with review, not evidence that this model should merge unattended.
