const OPERATOR_DEFAULTS_URL = '/api/panel/operator-defaults';
const SNAPSHOT_TTL_MS = 1_000;

let snapshot: { response: Response; expiresAt: number } | null = null;
let inFlight: Promise<Response> | null = null;
let version = 0;

export async function fetchOperatorDefaults(init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase();
  if (method !== 'GET') {
    version += 1;
    snapshot = null;
    inFlight = null;
    return fetch(OPERATOR_DEFAULTS_URL, init);
  }
  if (snapshot && snapshot.expiresAt > Date.now()) return snapshot.response.clone();
  if (!inFlight) {
    const requestVersion = version;
    const request = fetch(OPERATOR_DEFAULTS_URL, { ...init, cache: 'no-store' }).then((response) => {
      if (response.ok && version === requestVersion) {
        snapshot = { response: response.clone(), expiresAt: Date.now() + SNAPSHOT_TTL_MS };
      }
      return response;
    });
    inFlight = request;
    request.then(
      () => { if (inFlight === request) inFlight = null; },
      () => { if (inFlight === request) inFlight = null; },
    );
  }
  return inFlight.then((response) => response.clone());
}
