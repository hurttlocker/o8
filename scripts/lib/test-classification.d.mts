export function classifyTestSource(path: string, source: string): string[];
export function buildTestClassification(root: string): {
  schema: 'o8/test-classification/v1';
  generatedBy: string;
  resourceOwning: Array<{ path: string; reasons: string[] }>;
};
export function buildTestClassificationReport(root: string): {
  manifest: ReturnType<typeof buildTestClassification>;
  hermeticTests: number;
  resourceOwningTests: number;
};
