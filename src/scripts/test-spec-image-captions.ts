/**
 * test-spec-image-captions — sanity-check the spec image captioning pipeline.
 *
 * Reads o8.md from the current repository (which has real screenshot refs),
 * runs the captioning logic, and prints each image path + its resolved caption.
 *
 * Run: npx tsx src/scripts/test-spec-image-captions.ts
 */

import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve as pathResolve } from 'node:path';

import { captionImagesInSpec } from '@/lib/cortex/spec-image-captions';

const SPEC_PATH = pathResolve(process.cwd(), 'o8.md');
const IMAGE_REGEX = /!\[([^\]]*)\]\(([^)]+)\)\n\*\*\[image:\s*([^\]]+)\]\*\*/g;

async function main(): Promise<void> {
  const raw = readFileSync(SPEC_PATH, 'utf-8');

  // Surface every image ref the spec references before captioning runs so we
  // can compare with the captioned output.
  const refs: Array<{ alt: string; src: string }> = [];
  for (const match of raw.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)) {
    refs.push({ alt: match[1] ?? '', src: match[2] ?? '' });
  }
  console.log(`Found ${refs.length} image ref(s) in ${SPEC_PATH}`);
  for (const { alt, src } of refs) {
    const path = src.trim().split(/\s+/)[0];
    const abs = isAbsolute(path) ? path : pathResolve(dirname(SPEC_PATH), path);
    console.log(`  - alt="${alt}" src=${path} → ${abs}`);
  }

  console.log('\nRunning captionImagesInSpec...\n');
  const t0 = Date.now();
  const captioned = await captionImagesInSpec(SPEC_PATH, raw);
  const dt = Date.now() - t0;
  console.log(`captionImagesInSpec returned in ${dt}ms\n`);

  const captions: Array<{ alt: string; src: string; caption: string }> = [];
  for (const match of captioned.matchAll(IMAGE_REGEX)) {
    captions.push({
      alt: match[1] ?? '',
      src: (match[2] ?? '').trim().split(/\s+/)[0],
      caption: (match[3] ?? '').trim(),
    });
  }

  console.log(`Inlined ${captions.length} caption(s):\n`);
  for (const { alt, src, caption } of captions) {
    console.log(`  src: ${src}`);
    console.log(`  alt: ${alt}`);
    console.log(`  caption: ${caption}`);
    console.log('');
  }

  if (captions.length === 0) {
    console.warn('No captions inlined. Check that GEMINI_API_KEY is set and images resolve.');
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('test-spec-image-captions failed:', err);
  process.exit(1);
});
