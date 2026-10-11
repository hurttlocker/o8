import { resolveRequestPrincipalContext } from '@/lib/auth/principal';
import { listTranscriptVisualizations, publishVisualization } from '@/lib/visualizations/service';
import { visualizationBody, visualizationFailure, visualizationResponse } from '@/lib/visualizations/http';
import { visualizationReference } from '@/lib/visualizations/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const { document, warnings, check } = await publishVisualization(await visualizationBody(request), resolveRequestPrincipalContext(request));
    return visualizationResponse({ visualization: visualizationReference(document), warnings, check }, 201);
  } catch (error) { return visualizationFailure(error); }
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const visualizations = await listTranscriptVisualizations(Object.fromEntries(url.searchParams), resolveRequestPrincipalContext(request));
    return visualizationResponse({ visualizations });
  } catch (error) { return visualizationFailure(error); }
}
