const OPERATOR_DEFAULTS_VALUES_URL = '/api/panel/operator-defaults?include=values';
const VALUES_SNAPSHOT_TTL_MS = 1_000;

let snapshot: { response: Response; expiresAt: number } | null = null;
let inFlight: Promise<Response> | null = null;

export function invalidateOperatorDefaultsValuesSnapshot(): void {
  snapshot = null;
  inFlight = null;
}

export async function fetchOperatorDefaultsValues(): Promise<Response> {
  if (snapshot && snapshot.expiresAt > Date.now()) return snapshot.response.clone();
  if (!inFlight) {
    const request = fetch(OPERATOR_DEFAULTS_VALUES_URL, { cache: 'no-store' })
      .then((response) => {
        if (response.ok) {
          snapshot = {
            response: response.clone(),
            expiresAt: Date.now() + VALUES_SNAPSHOT_TTL_MS,
          };
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
