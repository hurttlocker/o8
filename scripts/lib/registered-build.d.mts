export function runRegisteredBuild(
  run: (command: string, args: string[], env?: NodeJS.ProcessEnv) => Promise<number>,
): Promise<number>;
