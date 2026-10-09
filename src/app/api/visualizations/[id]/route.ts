import { resolveRequestPrincipalContext } from '@/lib/auth/principal';
import { readVisualization } from '@/lib/visualizations/service';
import { visualizationFailure, visualizationResponse } from '@/lib/visualizations/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    return visualizationResponse({ visualization: readVisualization(id, resolveRequestPrincipalContext(request)) });
  } catch (error) { return visualizationFailure(error); }
}
