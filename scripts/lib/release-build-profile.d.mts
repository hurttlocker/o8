export function releaseBuildProfile(root: string, env?: NodeJS.ProcessEnv,
  options?: { release?: boolean; create?: boolean }): { profile: string; operator: string };
export function prebuildEnvironment(root: string, env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function boundBuildEnvironment(root: string, env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
