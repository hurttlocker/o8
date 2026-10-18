import 'server-only';
import { AsyncLocalStorage } from 'node:async_hooks';
export interface ComposerBrainRoute {
  runtime: 'codex' | 'claude-code' | null;
  model: string | null;
  binary?: string;
}
const context = new AsyncLocalStorage<ComposerBrainRoute>();
export function currentComposerBrainRoute(): ComposerBrainRoute | undefined { return context.getStore(); }
export function withComposerBrainRoute<T>(route: ComposerBrainRoute, run: () => T): T { return context.run(route, run); }
