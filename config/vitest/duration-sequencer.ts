import { relative } from 'node:path';
import { BaseSequencer, type TestSpecification } from 'vitest/node';
import durations from './hermetic-durations.json';

// Longest-first scheduling keeps slow fixtures off the end of a worker queue.
// Every shard uses the same compact estimates, never a local run cache.
export default class DurationSequencer extends BaseSequencer {
  private estimates = new Map<string, number>();
  private key(file: TestSpecification) {
    return relative(this.ctx.config.root, file.moduleId).replaceAll('\\', '/');
  }

  private duration(file: TestSpecification) {
    const key = this.key(file);
    if (!this.estimates.has(key)) {
      const outlier = (durations.slowFiles as Record<string, number>)[key];
      const jsdom = /@vitest-environment\s+jsdom/.test(readFileSync(file.moduleId, 'utf8'));
      this.estimates.set(key, outlier ?? (jsdom ? durations.jsdomMs : durations.defaultMs));
    }
    return this.estimates.get(key)!;
  }

  async sort(files: TestSpecification[]) {
    return [...files].sort((a, b) => this.duration(b) - this.duration(a)
      || (this.key(a) < this.key(b) ? -1 : this.key(a) > this.key(b) ? 1 : 0));
  }

  async shard(files: TestSpecification[]) {
    const { index, count } = this.ctx.config.shard!;
    const shards = Array.from({ length: count }, () => ({ duration: 0, files: [] as TestSpecification[] }));
    for (const file of await this.sort(files)) {
      const target = shards.reduce((a, b) => a.duration <= b.duration ? a : b);
      target.files.push(file);
      target.duration += this.duration(file);
    }
    return shards[index - 1].files;
  }
}
import { readFileSync } from 'node:fs';
