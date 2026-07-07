// Shared millisecond duration formatter: '<n>ms' under a second, else '<n.n>s'.
// Extracted from byte-identical copies in DemoRunSection and DiagnosticsTab.
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
