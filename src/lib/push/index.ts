/**
 * Mobile push notification subsystem (Web Push).
 *
 * Public surface:
 *   - getVapidKeys() — returns/generates VAPID keypair (private key signs JWT)
 *   - upsertPushSubscription / deletePushSubscription — subscription CRUD
 *   - notifyAll / notifyApprovalCreated / notifyAgentFinished / ... — fan-out
 *
 * Environment variables (see also `.env.example`):
 *   - O8_VAPID_PUBLIC_KEY  / O8_VAPID_PRIVATE_KEY — base64url-encoded raw
 *       VAPID keys. When unset, o8 generates a fresh pair on first run and
 *       persists to $DATA_DIR/vapid.json (mode 0600).
 *   - O8_VAPID_SUBJECT — mailto: URL embedded in the VAPID JWT (default
 *       "mailto:o8-local@localhost").
 *   - O8_PUSH_NOTIFICATIONS_ENABLED — set to "0" to disable all outbound
 *       pushes even if subscriptions are registered. Default: enabled.
 *
 * Issue: https://github.com/hurttlocker/cortex-ide/issues/639
 */

export {
  getVapidKeys,
  buildVapidJwt,
  base64UrlEncode,
  base64UrlDecode,
} from './vapid';
export type { VapidKeys } from './vapid';

export {
  upsertPushSubscription,
  deletePushSubscription,
  getPushSubscription,
  listPushSubscriptions,
  recordDeliverySuccess,
  recordDeliveryFailure,
} from './store';
export type {
  StoredPushSubscription,
  UpsertPushSubscriptionInput,
} from './store';

export {
  sendPushToSubscription,
} from './send';
export type { PushPayload, SendResult } from './send';

export {
  notifyAll,
  notifyAllInBackground,
  notifyApprovalCreated,
  notifyAgentFinished,
  notifyMergeConflict,
  notifyOrchestratorReady,
} from './notify';
