export interface ContextualConversation {
  requestContext: string;
  initialDraft?: string;
  placeholder?: string;
  onDraftChange?: (draft: string) => void;
  onBusyChange?: (busy: boolean) => void;
}

/** Attach context to the provider turn while leaving the visible user text intact. */
export function contextualTurnMessage(message: string, context?: string): string {
  return context ? `${message}\n\n${context}` : message;
}
