/**
 * Tauri Desktop — Barrel Export
 */

export {
  isTauri,
  getDesktopInfo,
  checkPort,
  startWsServer,
  cortexAvailable,
  getAppDataDir,
  notify,
  showWindow,
  hideWindow,
  storeGet,
  storeSet,
} from './bridge';

export type {
  DesktopInfo,
  SidecarResult,
} from './bridge';
