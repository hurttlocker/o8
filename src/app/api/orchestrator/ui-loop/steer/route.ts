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
  const previewUrl = typeof record.previewUrl === 'string' ? record.previewUrl.trim() : undefined;
  const readySelector = typeof record.readySelector === 'string' ? record.readySelector.trim() : undefined;
  const readyText = typeof record.readyText === 'string' ? record.readyText : undefined;
  const element = typeof record.element === 'string' ? record.element.trim() : undefined;
  const elementFilePath = typeof record.elementFilePath === 'string' ? record.elementFilePath.trim() : undefined;
  const rect = asRecord(record.elementRect);
  const elementRect = rect
    && ['top', 'left', 'width', 'height'].every((key) => typeof rect[key] === 'number' && Number.isFinite(rect[key]))
    ? rect as unknown as { top: number; left: number; width: number; height: number }
    : undefined;

  try {
    return operatorSuccess(await steerWarmUiLoop({
      repoPath,
      text,
      previewImageDataUri,
      previewUrl,
      readySelector,
      readyText,
      element,
      elementRect,
      elementFilePath,
    }));
  } catch (error) {
    return operatorError(
      'ui_loop_steer_failed',
      error instanceof Error ? error.message : 'Unable to steer the warm Design Mode packet.',
      error instanceof SteerPacketUnavailableError ? 409 : 500,
      error,
    );
  }
}
