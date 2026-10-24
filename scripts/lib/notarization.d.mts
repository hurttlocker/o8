export type NotarizationCredentials = { keychainProfile: string } | {
  appleId: string;
  teamId: string;
  password: string;
};

export type NotarizationRunner = (
  command: string,
  args: string[],
  options: { stdio: 'inherit' | 'pipe' },
) => unknown;

export function resolveNotarizationCredentials(env?: NodeJS.ProcessEnv): NotarizationCredentials;

export function submitForNotarization(
  artifact: string,
  credentials: NotarizationCredentials,
  run?: NotarizationRunner,
): void;

export function stapleAndValidate(
  artifact: string,
  run?: NotarizationRunner,
): void;
