type Spawn = (command: string, args: string[], env?: NodeJS.ProcessEnv) => Promise<number>;
export function prebuildPreflight(): void;
export function runPrebuild(context: { canReuse: boolean;
  runBuild: (operation: (run: Spawn) => Promise<number>) => Promise<number> }): Promise<number>;
