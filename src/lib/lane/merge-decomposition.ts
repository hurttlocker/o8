import type { Lane } from '@/lib/lane/types';

export async function enqueueMergeDecompositions(
  repoPath: string,
  runtime: Lane['runtime'],
): Promise<string> {
  try {
    const { enqueueDecompositionsAfterMerge } = await import('@/lib/dispatch/decomposition-pipeline');
    const decomposition = await enqueueDecompositionsAfterMerge({ repoPath, runtime });
    if (decomposition.enqueued === 0) return '';
    const names = decomposition.candidates
      .map((candidate) => candidate.relativePath)
      .join(', ');
    return ` Enqueued ${decomposition.enqueued} decomposition dispatch${decomposition.enqueued === 1 ? '' : 'es'} for over-ceiling file${decomposition.enqueued === 1 ? '' : 's'}: ${names}.`;
  } catch (error) {
    console.warn(
      `[lane-merge] Decomposition scan failed for ${repoPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return '';
  }
}
