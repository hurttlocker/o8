export const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
export const PLAN_SCOPES = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;
export const PLAN_USAGE_URL = 'https://chatgpt.com/settings/usage';

export class ChatGPTPlanError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 409) {
    super(message);
    this.name = 'ChatGPTPlanError';
  }
}

export interface PlanTokens {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  expiresAt: number;
  scopes: string[];
  refreshUncertain?: boolean;
}

export interface PlanRegistration {
  id: string;
  issuer: string;
  subject: string;
  clientId: string;
  label: string;
  tokens: PlanTokens | null;
}

export interface PlanRecord {
  owner: string;
  generation: number;
  activeId: string | null;
  welcomed: boolean;
  registrations: PlanRegistration[];
}

export interface PlanStore {
  hostId(): Promise<string>;
  locked<T>(owner: string, action: () => Promise<T>): Promise<T>;
  read(owner: string): Promise<PlanRecord>;
  write(owner: string, record: PlanRecord): Promise<void>;
}

export interface PlanModel { id: string; label: string }
export interface PlanSelection { accountId: string; generation: number; desktopEpoch: string }

export interface PlanStatus {
  connected: boolean;
  planEnabled: boolean;
  activeId: string | null;
  welcomed: boolean;
  accounts: Array<{ id: string; label: string; connected: boolean }>;
  models: PlanModel[];
  selection?: PlanSelection;
  usageUrl: string;
  modelLoadError?: string;
}

export function emptyPlanRecord(owner: string): PlanRecord {
  return { owner, generation: 0, activeId: null, welcomed: false, registrations: [] };
}
