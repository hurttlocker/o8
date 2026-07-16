import { describe, it, expect } from 'vitest';
import { o8OwnedTabs } from './use-o8-browser-tabs';

const tab = (id: string, url: string, title = '') => ({ id, url, title });
const O8_HOST = 'localhost:47120';

describe('o8OwnedTabs', () => {
  it('drops o8 itself — its own port is not a page it opened', () => {
    const out = o8OwnedTabs(
      [
        tab('1', `http://${O8_HOST}/dashboard`, 'o8'),
        tab('2', 'http://127.0.0.1:58929/index.html', 'o8 Operator'),
      ],
      O8_HOST,
    );
    expect(out.map((t) => t.title)).toEqual(['o8 Operator']);
  });

  it('drops o8 on any path or scheme, not just the exact url', () => {
    const out = o8OwnedTabs(
      [tab('1', `http://${O8_HOST}/`, 'a'), tab('2', `http://${O8_HOST}/mobile#tk=x`, 'b')],
      O8_HOST,
    );
    expect(out).toEqual([]);
  });

  it('keeps a real page and surfaces its host as the row detail', () => {
    const out = o8OwnedTabs([tab('1', 'http://127.0.0.1:58929/index.html', 'o8 Operator')], O8_HOST);
    expect(out).toEqual([
      { id: '1', url: 'http://127.0.0.1:58929/index.html', title: 'o8 Operator', host: '127.0.0.1:58929' },
    ]);
  });

  it('keeps a same-machine page on a DIFFERENT port — only o8 itself goes', () => {
    const out = o8OwnedTabs([tab('1', 'http://localhost:3001/', 'dev')], O8_HOST);
    expect(out).toHaveLength(1);
  });

  it('falls back to the host when a tab has no title', () => {
    const out = o8OwnedTabs([tab('1', 'http://localhost:4321/', '   ')], O8_HOST);
    expect(out[0]?.title).toBe('localhost:4321');
  });

  it('drops unparseable urls rather than rendering a broken row', () => {
    expect(o8OwnedTabs([tab('1', 'not-a-url', 'junk')], O8_HOST)).toEqual([]);
    expect(o8OwnedTabs([tab('1', '', 'blank')], O8_HOST)).toEqual([]);
  });

  it('dedupes by url', () => {
    const out = o8OwnedTabs(
      [tab('1', 'http://127.0.0.1:58929/', 'a'), tab('2', 'http://127.0.0.1:58929/', 'b')],
      O8_HOST,
    );
    expect(out).toHaveLength(1);
  });

  it('is empty for no tabs — the card hides rather than showing a placeholder', () => {
    expect(o8OwnedTabs([], O8_HOST)).toEqual([]);
  });

  it('keeps everything when the o8 host is unknown rather than dropping real pages', () => {
    const out = o8OwnedTabs([tab('1', 'http://127.0.0.1:58929/', 'page')], null);
    expect(out).toHaveLength(1);
  });
});
