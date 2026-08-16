import { extractSourcemapFromFile } from '@vitest/utils/source-map/node';
import { describe, expect, it } from 'vitest';

describe('Vitest source-map residue', () => {
  it('keeps the original stack when a dependency exposes invalid inline-map JSON', () => {
    const generated = '//# sourceMappingURL=data:application/json;base64,77+9';

    expect(extractSourcemapFromFile(generated, '/virtual/generated-loader.cjs')).toBeUndefined();
  });
});
