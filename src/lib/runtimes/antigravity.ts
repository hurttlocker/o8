import { declarativeWorkerRuntimes } from './declarative-workers';

export const antigravityRuntime = declarativeWorkerRuntimes.find(runtime => runtime.id === 'antigravity')!;
