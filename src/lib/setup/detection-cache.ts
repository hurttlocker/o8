import { fetchOnce } from '@/lib/panel/fetch-cache';

interface SetupDetectionTool {
  id?: string;
  details?: {
    authedProviders?: unknown;
  };
}

interface SetupDetectionPayload {
  tools?: SetupDetectionTool[];
}

let cachedDetection: SetupDetectionPayload | null = null;
let detectionPromise: Promise<SetupDetectionPayload | null> | null = null;

function normalizeProviders(value: unknown) {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean),
    ),
  ).sort();
}

export function getCachedOpenCodeProviders() {
  const tool = cachedDetection?.tools?.find((entry) => entry.id === 'opencode');
  return normalizeProviders(tool?.details?.authedProviders);
}

export async function loadSetupDetection() {
  if (cachedDetection) return cachedDetection;
  if (detectionPromise) return detectionPromise;

  detectionPromise = fetchOnce('/api/setup/detect', {
    cache: 'no-store',
    headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
  })
    .then(async (response) => {
      if (!response.ok) return null;
      const payload = await response.json() as SetupDetectionPayload;
      cachedDetection = payload;
      return payload;
    })
    .catch(() => null)
    .finally(() => {
      detectionPromise = null;
    });

  return detectionPromise;
}

export async function loadOpenCodeProviders() {
  const detection = await loadSetupDetection();
  const tool = detection?.tools?.find((entry) => entry.id === 'opencode');
  return normalizeProviders(tool?.details?.authedProviders);
}
