import type { OperatorDefaults } from './defaults';

/**
 * Release metadata bundled with the app so the installed runtime can audit
 * feature age without a source checkout or Git executable.
 */
export const SHIPPED_DARK_FLAG_LANDING_RELEASES: Readonly<Partial<Record<keyof OperatorDefaults, string>>> = Object.freeze({
  experimentalOpencode: '0.1.681',
  experimentalGemini: '0.1.681',
  experimentalChat: '0.1.681',
  experimentalCanvas: '0.1.681',
  nativeBrowserView: '0.1.681',
  broadcastCommentary: '0.1.696',
  broadcastVoice: '0.1.698',
  apfsDependencyImages: '0.1.691',
  mergeTestReplayEnabled: '0.1.681',
  quizGateEnabled: '0.1.681',
  buyinDocEnabled: '0.1.681',
  productTelemetryEnabled: '0.1.681',
  telemetryOptIn: '0.1.681',
  crashReportsEnabled: '0.1.681',
});
