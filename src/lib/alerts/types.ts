/**
 * Alert system types — foundation for in-app + future outbound alerts.
 *
 * Alerts are derived from existing polling data (no new API calls).
 * The same Alert object will serialize to webhooks/push when outbound ships.
 */

export type AlertType =
  | 'stuck'
  | 'approval'
  | 'completed'
  | 'error'
  | 'context-warn'
  | 'context-critical'
  | 'offline';

export type AlertSeverity = 'urgent' | 'warning' | 'success' | 'info';

export interface Alert {
  id: string;
  type: AlertType;
  severity: AlertSeverity;
  agentId: string;
  agentName: string;
  title: string;
  detail: string;
  timestamp: number;
  read: boolean;
  dismissed: boolean;
  /** Whether this alert has an actionable button */
  actionable: boolean;
  /** Button label when actionable */
  actionLabel?: string;
  /** Session key to navigate to */
  sessionKey?: string;
}

/** Severity ordering for sort (urgent first) */
export const SEVERITY_ORDER: Record<AlertSeverity, number> = {
  urgent: 0,
  warning: 1,
  info: 2,
  success: 3,
};

/** Alert type → severity mapping */
export const TYPE_SEVERITY: Record<AlertType, AlertSeverity> = {
  stuck: 'warning',
  approval: 'urgent',
  completed: 'success',
  error: 'urgent',
  'context-warn': 'warning',
  'context-critical': 'urgent',
  offline: 'warning',
};

/** Alert type → icon name (Lucide) */
export const TYPE_ICON: Record<AlertType, string> = {
  stuck: 'Clock',
  approval: 'ShieldCheck',
  completed: 'CheckCircle2',
  error: 'AlertTriangle',
  'context-warn': 'Gauge',
  'context-critical': 'Gauge',
  offline: 'WifiOff',
};

/** Alert severity → color */
export const SEVERITY_COLOR: Record<AlertSeverity, string> = {
  urgent: '#ff3b30',
  warning: '#ff9f0a',
  success: '#34c759',
  info: '#007aff',
};
