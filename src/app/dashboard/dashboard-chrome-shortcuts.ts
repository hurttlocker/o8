export interface DashboardChromeShortcutActions {
  openCanvas: () => void;
  openSettings: () => void;
  spawnOrchestrator: () => void;
  toggleBottomPanel: () => void;
  toggleRightPanel: () => void;
  toggleSidebar: () => void;
  toggleTerminalMode: () => void;
}

export function createDashboardChromeKeydownHandler(actions: DashboardChromeShortcutActions) {
  return (event: KeyboardEvent) => {
    if (!(event.metaKey || event.ctrlKey)) return;
    if (event.altKey) {
      if (event.code === 'KeyB' && !event.shiftKey) {
        event.preventDefault();
        actions.toggleRightPanel();
      }
      if (event.code === 'KeyC' && !event.shiftKey) {
        event.preventDefault();
        actions.openCanvas();
      }
      return;
    }
    if (event.shiftKey && event.code === 'KeyJ') {
      event.preventDefault();
      actions.toggleTerminalMode();
      return;
    }
    if (event.shiftKey) return;
    switch (event.key.toLowerCase()) {
      case 't':
        event.preventDefault();
        actions.spawnOrchestrator();
        break;
      case 'b':
        event.preventDefault();
        actions.toggleSidebar();
        break;
      case 'j':
        event.preventDefault();
        actions.toggleBottomPanel();
        break;
      case ',':
        event.preventDefault();
        actions.openSettings();
        break;
      default:
        break;
    }
  };
}
