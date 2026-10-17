export const OPEN_COMPOSER_BRAIN_EVENT = 'o8:open-composer-brain';
export interface ComposerBrainRequest { repoPath: string; prompt?: string; context?: string }
export function openComposerBrain(request: ComposerBrainRequest) {
  window.dispatchEvent(new CustomEvent<ComposerBrainRequest>(OPEN_COMPOSER_BRAIN_EVENT, { detail: request }));
}
