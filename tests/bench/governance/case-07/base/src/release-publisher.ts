export interface ReleaseInput {
  repositoryId: string;
  releaseId: string;
}

export interface PublishResult {
  status: 'published';
  persisted: boolean;
}

export type ReleaseWriter = (input: ReleaseInput) => Promise<void>;

export async function publishRelease(
  input: ReleaseInput,
  writeRelease: ReleaseWriter,
): Promise<PublishResult> {
  await writeRelease(input);
  return { status: 'published', persisted: true };
}
