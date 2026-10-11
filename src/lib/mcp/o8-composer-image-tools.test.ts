import { describe, expect, it } from 'vitest';
import { createO8WebviewToolHandlers, O8_WEBVIEW_TOOLS } from './o8-webview-tools';

describe('registered operator image attachment', () => {
  it('discovers strict image tools and exposes their registered handlers', () => {
    const handlers = createO8WebviewToolHandlers(() => { throw new Error('must not connect'); });
    for (const name of ['o8_view_inspect_composer', 'o8_view_attach_image', 'o8_view_image_attachment_status']) {
      expect(O8_WEBVIEW_TOOLS.find(tool => tool.name === name)?.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
      if (name !== 'o8_view_image_attachment_status') expect(O8_WEBVIEW_TOOLS.find(tool => tool.name === name)?.inputSchema.properties).toHaveProperty('allow_background', expect.objectContaining({ type: 'boolean' }));
      expect(typeof handlers[name]).toBe('function');
    }
  });
  it('validates malformed input before obtaining any client', async () => {
    const handlers = createO8WebviewToolHandlers(() => { throw new Error('must not connect'); });
    for (const [name, args] of [
      ['o8_view_attach_image', {}], ['o8_view_image_attachment_status', {}],
      ['o8_view_inspect_composer', { script: 'arbitrary' }],
      ['o8_view_inspect_composer', { allow_background: 'true' }],
    ] as const) {
      const result = await handlers[name](args);
      expect(result.isError).toBe(true);
      const content = result.content[0];
      if (content.type !== 'text') throw new Error('Expected text receipt');
      expect(JSON.parse(content.text).code).toMatch(/^invalid_/);
    }
  });

});
