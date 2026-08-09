export interface NotarizationCredentials {
  appleId: string;
  teamId: string;
  password: string;
}

export type NotarizationRunner = (
  command: string,
  args: string[],
  options: { stdio: 'inherit' },
) => unknown;

export function submitForNotarization(
  artifact: string,
  credentials: NotarizationCredentials,
  run?: NotarizationRunner,
): void;

export function stapleAndValidate(
  artifact: string,
  run?: NotarizationRunner,
): void;
