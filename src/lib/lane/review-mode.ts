/** Per-process recovery hold; never writes operator defaults or review claims. */
export function manualReviewRequested(): boolean {
  return process.env.O8_REVIEW_MODE === 'manual';
}

export function validateReviewMode(): 'automatic' | 'manual' {
  const mode = process.env.O8_REVIEW_MODE ?? 'automatic';
  if (mode !== 'automatic' && mode !== 'manual') {
    throw new Error('O8_REVIEW_MODE must be automatic or manual.');
  }
  return mode;
}
