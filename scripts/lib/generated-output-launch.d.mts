export function generatedOutputLaunch(mode: string, args?: string[]): {
  command: string;
  args: string[];
};

export function runGeneratedOutputLaunch(
  mode: string,
  args?: string[],
  env?: NodeJS.ProcessEnv,
): Promise<number>;
