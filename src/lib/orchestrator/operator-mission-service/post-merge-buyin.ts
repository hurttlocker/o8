export async function launchPostMergeBuyin(input: {
  repoPath: string;
  laneId: string;
  packetId: string;
  packetTitle: string;
  packetSummary: string;
  mergeSha: string | null;
  deviationsRaw: string | null;
}): Promise<void> {
  try {
    const { resolveBuyinDocEnabledSync } = await import('@/lib/operator/defaults');
    const { shouldGenerateBuyinDoc, generateBuyinDoc } = await import('@/lib/lane/buyin-doc');
    if (!shouldGenerateBuyinDoc({
      enabled: resolveBuyinDocEnabledSync(),
      mergeOk: true,
      packetId: input.packetId,
    })) return;

    const { listArtifacts, artifactAbsPath } = await import('@/lib/artifacts/store');
    const demoArtifacts = listArtifacts({ packetId: input.packetId })
      .filter((artifact) => artifact.kind === 'screenshot' || artifact.kind === 'video')
      .map((artifact) => ({
        absPath: artifactAbsPath(artifact.relPath),
        label: artifact.label,
        phase: artifact.phase,
        kind: artifact.kind,
        mimeType: artifact.mimeType,
      }));
    void generateBuyinDoc({
      repoPath: input.repoPath,
      laneId: input.laneId,
      packetId: input.packetId,
      packetTitle: input.packetTitle,
      packetSummary: input.packetSummary,
      mergeSha: input.mergeSha,
      deviationsRaw: input.deviationsRaw,
      demoArtifacts,
    }).catch((error) => {
      console.warn(`[buyin-doc] Generation threw for packet ${input.packetId}:`, error);
    });
  } catch (error) {
    console.warn(`[buyin-doc] Failed to launch generation for packet ${input.packetId}:`, error);
  }
}
