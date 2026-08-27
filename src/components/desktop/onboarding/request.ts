export type OnboardingRequest = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;
