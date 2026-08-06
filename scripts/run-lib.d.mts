// Types for run-lib.mjs (allowJs is off repo-wide). Only the pure parser is
// declared — the spawn helpers are script-side only and have no TS callers.
export declare function parseEnvPrefixArgv(argv: string[]): {
  assignments: Record<string, string>;
  command: string | undefined;
  args: string[];
};
