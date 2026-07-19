export interface ComposerTargetCandidate {
  activeComposer: boolean;
  disabled: boolean;
  focused: boolean;
  visible: boolean;
}

/**
 * Resolve the editable that webview typing may target. A genuinely focused,
 * visible editable wins for generic form use; otherwise the active workspace
 * composer's semantic marker wins. Hidden resident-panel focus is ignored.
 */
export function resolveComposerTargetIndex(candidates: ComposerTargetCandidate[]): number {
  const focused = candidates.findIndex((candidate) => (
    candidate.focused && candidate.visible && !candidate.disabled
  ));
  if (focused >= 0) return focused;
  return candidates.findIndex((candidate) => (
    candidate.activeComposer && candidate.visible && !candidate.disabled
  ));
}

export function buildPrepareComposerTargetScript(): string {
  return `(() => {
    const isVisible = (element) => {
      if (!(element instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const nodes = Array.from(document.querySelectorAll('textarea, input:not([type]), input[type="text"], input[type="search"], input[type="email"], input[type="url"], input[type="tel"], input[type="password"], [contenteditable="true"]'));
    const active = document.activeElement;
    const candidates = nodes.map((element) => ({
      activeComposer: element.getAttribute('data-o8-active-composer') === 'true',
      disabled: element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true',
      focused: element === active,
      visible: isVisible(element),
    }));
    const resolveTarget = ${resolveComposerTargetIndex.toString()};
    const index = resolveTarget(candidates);
    if (index < 0) {
      return JSON.stringify({
        ok: false,
        error: 'No visible editable is focused and the active workspace tab has no available composer. Focus an input or open an active chat composer, then retry.',
      });
    }
    const target = nodes[index];
    try { target.focus({ preventScroll: true }); } catch (_) { target.focus(); }
    return JSON.stringify({
      ok: document.activeElement === target,
      target: target.getAttribute('data-o8-active-composer') === 'true' ? 'active-composer' : 'focused-editable',
    });
  })()`;
}
