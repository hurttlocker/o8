// Types for the pure parsers in kill-port.mjs (allowJs is off repo-wide, and
// tests/script-shell-neutral.test.ts covers the Windows-only netstat branch).
export declare function parseLsofPids(stdout: string): number[];
export declare function parseNetstatPids(stdout: string, port: number): number[];
