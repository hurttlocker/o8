export type ThinkingEffort = 'adaptive' | 'low' | 'medium' | 'high' | 'max' | 'xhigh';

export type ManualThinkingEffort = Exclude<ThinkingEffort, 'adaptive'>;

export const THINKING_EFFORTS: ThinkingEffort[] = ['adaptive', 'low', 'medium', 'high', 'max', 'xhigh'];
export const MANUAL_THINKING_EFFORTS: ManualThinkingEffort[] = ['low', 'medium', 'high', 'max', 'xhigh'];

export function isThinkingEffort(value: unknown): value is ThinkingEffort {
  return typeof value === 'string' && THINKING_EFFORTS.includes(value as ThinkingEffort);
}

export function isManualThinkingEffort(value: unknown): value is ManualThinkingEffort {
  return typeof value === 'string' && MANUAL_THINKING_EFFORTS.includes(value as ManualThinkingEffort);
}
