export function resolveTypecheckChecker(options?: {
  platform?: string;
  arch?: string;
  libc?: string;
  resolve?: (specifier: string) => string;
  stderr?: (line: string) => unknown;
  allowFallback?: boolean;
}): { name: 'tsrs' | 'tsc'; path: string };
