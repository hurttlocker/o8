import { NextRequest } from 'next/server';
import { SteerPacketUnavailableError } from '@/lib/orchestrator/operator-mission-service/steer';
import { steerWarmUiLoop } from '@/lib/orchestrator/ui-loop';
import { asRecord, operatorError, operatorSuccess, parseJsonBody } from '../../_utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const record = asRecord(await parseJsonBody(request));
  if (!record) {
    return operatorError('invalid_request', 'Invalid JSON body.', 400);
  }
  const repoPath = typeof record.repo === 'string' ? record.repo.trim() : '';
  const text = typeof record.text === 'string' ? record.text.trim() : '';
  if (!repoPath || !text) {
    return operatorError('invalid_request', 'repo and text are required.', 400);
  }
  const previewImageDataUri = typeof record.previewImageDataUri === 'string'
    ? record.previewImageDataUri
    : undefined;

  try {
    return operatorSuccess(await steerWarmUiLoop({ repoPath, text, previewImageDataUri }));
  } catch (error) {
    return operatorError(
      'ui_loop_steer_failed',
      error instanceof Error ? error.message : 'Unable to steer the warm Design Mode packet.',
      error instanceof SteerPacketUnavailableError ? 409 : 500,
      error,
    );
  }
}
