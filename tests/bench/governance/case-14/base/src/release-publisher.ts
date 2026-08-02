export interface ReleaseInput {
  repositoryId: string;
  releaseId: string;
}

export type ReleaseWriter = (input: ReleaseInput) => Promise<void>;

export async function publishRelease(
  input: ReleaseInput,
  writeRelease: ReleaseWriter,
): Promise<void> {
  await writeRelease(input);
}
