type ComposerCenterListener = () => void;

let composerCenter: HTMLElement | null = null;
const listeners = new Set<ComposerCenterListener>();

function notifyListeners() {
  listeners.forEach((listener) => listener());
}

export function registerComposerCenter(element: HTMLElement) {
  composerCenter = element;
  notifyListeners();

  return () => {
    if (composerCenter !== element) return;
    composerCenter = null;
    notifyListeners();
  };
}

export function getRegisteredComposerCenter() {
  return composerCenter;
}

export function subscribeToComposerCenter(listener: ComposerCenterListener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
