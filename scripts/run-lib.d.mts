// Types for run-lib.mjs (allowJs is off repo-wide). Spawn helpers remain
// script-side only; these pure helpers also have TypeScript callers.
export declare const SERVER_ONLY_STUB_NODE_OPTION: string;

export declare function canonicalizeServerOnlyStubNodeOptions(
  value: string | undefined,
): string | undefined;

export declare function canonicalizeServerOnlyStubEnv<T extends Record<string, string | undefined>>(
  env: T,
): T;

export declare function withServerOnlyStubNodeOptions(
  value?: string,
): string;

export declare function parseEnvPrefixArgv(argv: string[]): {
  assignments: Record<string, string>;
  command: string | undefined;
  args: string[];
};
