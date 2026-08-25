export function classifyTestSource(path: string, source: string): string[];
export function buildTestClassification(root: string): {
  schema: 'o8/test-classification/v1';
  generatedBy: string;
  totalTests: number;
  hermeticTests: number;
  resourceOwningTests: number;
  resourceOwning: Array<{ path: string; reasons: string[] }>;
};
