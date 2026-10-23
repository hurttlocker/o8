import { NextRequest } from 'next/server';
import { resolveRequestPrincipal } from '@/lib/auth/principal';
import { requirePanelAuth } from '@/lib/panel/auth';
import { previewParkedOutput, validParkedOutputSelection } from '@/lib/workspace/parked-output-preview';
import { operatorError, operatorSuccess } from '../../_utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  if (resolveRequestPrincipal(request) !== 'operator') {
    return operatorError('forbidden', 'Parked output disposition previews are operator-only.', 403);
  }
  const params = request.nextUrl.searchParams;
  const kind = params.get('kind');
  const operationId = params.get('operationId');
  if (!validParkedOutputSelection(kind, operationId) || params.getAll('kind').length !== 1
    || params.getAll('operationId').length !== 1 || [...params.keys()].some(key => key !== 'kind' && key !== 'operationId')) {
    return operatorError('invalid_request', 'Provide exactly kind and operationId for one parked operation.', 400);
  }
  try {
    return operatorSuccess(previewParkedOutput(kind, operationId!));
  } catch {
    return operatorError('parked_preview_unavailable', 'The selected operation has no consistent completed parked record.', 409);
  }
}
