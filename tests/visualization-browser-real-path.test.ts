import { createServer, type Server } from 'node:http';
import { createSocket } from 'node:dgram';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultVisualizationTheme, visualizationSrcdoc } from '@/lib/visualizations/document';

// Dedicated receipt: O8_VISUALIZATION_BROWSER=/usr/bin/chromium vitest run this file.
// The default hermetic suite does not download or require an installed browser.
describe.runIf(Boolean(process.env.O8_VISUALIZATION_BROWSER))('visualization sandbox in a real browser', () => {
  let server: Server;
  let browser: Browser;
  let page: Page;
  let base: string;
  let probes: string[] = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url !== '/') probes.push(req.url ?? 'unknown');
      res.setHeader('content-type', 'text/html');
      res.setHeader('content-security-policy', "frame-src http://localhost:* http://127.0.0.1:* 'self'; frame-ancestors 'self'");
      res.end('<html><body><div id="private">host secret</div><iframe id="visual" sandbox="allow-scripts" style="width:728px;height:600px;border:0"></iframe></body></html>');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test server');
    base = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ executablePath: process.env.O8_VISUALIZATION_BROWSER, headless: true });
    page = await browser.newPage();
  });
  afterAll(async () => { await browser?.close(); if (server) await new Promise<void>(resolve => server.close(() => resolve())); });

  async function mount(html: string) {
    await page.goto(base);
    probes = [];
    await page.evaluate(srcdoc => {
      const frame = document.querySelector<HTMLIFrameElement>('#visual')!;
      frame.srcdoc = srcdoc;
      (window as unknown as { heights: number[] }).heights = [];
      addEventListener('message', event => {
        if (event.source === frame.contentWindow && event.data?.type === 'o8-visualization:height') (window as unknown as { heights: number[] }).heights.push(event.data.height);
      });
    }, await visualizationSrcdoc(html, 'fixture', defaultVisualizationTheme()));
    await page.waitForFunction(() => (window as unknown as { heights: number[] }).heights.length > 0);
    const frame = page.frames().find(frame => frame.parentFrame()?.parentFrame() === page.mainFrame());
    if (!frame) throw new Error(`No content frame: ${JSON.stringify(page.frames().map(item => ({ url: item.url(), parent: item.parentFrame()?.url(), grandparent: item.parentFrame()?.parentFrame()?.url() })))}`);
    return frame;
  }

  it('renders natural height, preserves interaction through live theme updates, and separates both frame origins', async () => {
    const frame = await mount('<section style="height:240px"><button id="count">0</button></section><script>document.querySelector("#count").addEventListener("click", e => e.target.textContent = Number(e.target.textContent) + 1)</script>');
    await frame.locator('#count').click();
    expect(await frame.locator('#count').textContent()).toBe('1');
    const theme = defaultVisualizationTheme('light');
    await page.evaluate(theme => document.querySelector<HTMLIFrameElement>('#visual')!.contentWindow!.postMessage({ type: 'o8-visualization:theme', nonce: 'fixture', theme }, '*'), theme);
    await frame.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    expect(await frame.locator('#count').textContent()).toBe('1');
    expect(await frame.evaluate(() => { try { return parent.document.body.innerHTML; } catch { return 'blocked'; } })).toBe('blocked');
    expect(await frame.evaluate(() => { try { return top?.document.body.innerHTML; } catch { return 'blocked'; } })).toBe('blocked');
    expect(await page.evaluate(() => (window as unknown as { heights: number[] }).heights.at(-1))).toBe(240);
  });

  it('blocks network, app API access, nested frames, popups and programmatic self-navigation', async () => {
    const frame = await mount(`<p>Offline</p><script>
      fetch('${base}/api/secret').catch(() => {});
      const img = new Image(); img.src = '${base}/image?secret=probe';
      const child = document.createElement('iframe'); child.src = '${base}/frame'; document.body.append(child);
      window.open('${base}/popup');
    </script>`);
    await frame.evaluate(url => { location.href = url; }, `${base}/navigation?secret=probe`).catch(() => {});
    await page.waitForTimeout(200);
    expect(probes.filter(path => path !== '/favicon.ico')).toEqual([]);
    expect(await page.locator('#private').textContent()).toBe('host secret');
    expect(browser.contexts().flatMap(context => context.pages())).toHaveLength(1);
  });

  it('does not let HTML parser delimiters escape into the trusted outer frame', async () => {
    const frame = await mount('<p id="payload">&lt;/script&gt;</p><script>try { parent.document.body.dataset.escaped="yes"; } catch { document.body.dataset.blocked="yes"; }</script>');
    expect(await frame.locator('body').getAttribute('data-blocked')).toBe('yes');
    expect(await frame.locator('#payload').textContent()).toBe('</script>');
    expect(await page.locator('#private').textContent()).toBe('host secret');
  });

  it('blocks WebRTC UDP, fresh realms, SRI script requests and unsealed child scripts', async () => {
    const udp = createSocket('udp4');
    const packets: Buffer[] = [];
    udp.on('message', packet => packets.push(packet));
    await new Promise<void>(resolve => udp.bind(0, '127.0.0.1', resolve));
    const address = udp.address();
    try {
      const frame = await mount(`<p>Isolation probe</p><script>
        globalThis.proof = [];
        function attempt(C, label) { try { const pc = new C({iceServers:[{urls:'stun:127.0.0.1:${address.port}'}]}); pc.createDataChannel('probe'); pc.createOffer().then(o=>pc.setLocalDescription(o)); proof.push(label+':sent'); } catch { proof.push(label+':blocked'); } }
        attempt(globalThis.RTCPeerConnection, 'own');
        try { Object.defineProperty(globalThis, 'RTCPeerConnection', {value: function(){}}); proof.push('restored'); } catch { proof.push('immutable'); }
        for (const kind of ['blank', 'srcdoc', 'aboutblank', 'write']) {
          const f = document.createElement('iframe');
          if (kind === 'srcdoc') f.srcdoc = '<p>child</p>';
          if (kind === 'aboutblank') f.src = 'about:blank';
          document.body.append(f);
          try { const C = f.contentWindow.RTCPeerConnection; if(kind === 'write') { f.contentDocument.open(); f.contentDocument.write('<p>fresh</p>'); f.contentDocument.close(); } f.remove(); attempt(C, kind); } catch { proof.push(kind+':opaque'); }
        }
        const script = document.createElement('script');
        script.src = '${base}/script?secret=probe';
        // A hash allowlist alone can authorize an external script via SRI.
        const policy = document.querySelectorAll('meta[http-equiv="Content-Security-Policy"]')[1].content;
        script.integrity = policy.match(/sha256-[A-Za-z0-9+/=]+/)[0]; document.body.append(script);
        const child = document.createElement('iframe');
        child.id = 'unsealed-child';
        child.srcdoc = '<p id="unguarded">fresh</p><script>document.body.dataset.unsealed="yes"; new RTCPeerConnection({iceServers:[{urls:"stun:127.0.0.1:${address.port}"}]}).createDataChannel("probe");<' + '/script>';
        document.body.append(child);
      </script>`);
      expect(await frame.evaluate(() => (globalThis as unknown as { proof: string[] }).proof)).toEqual([
        'own:blocked', 'immutable', 'blank:opaque', 'srcdoc:opaque', 'aboutblank:opaque', 'write:opaque',
      ]);
      await page.waitForTimeout(700);
      const child = frame.frameLocator('#unsealed-child');
      expect(await child.locator('#unguarded').textContent()).toBe('fresh');
      expect(await child.locator('body').getAttribute('data-unsealed')).toBeNull();
      expect(packets).toHaveLength(0);
      expect(probes.filter(path => path !== '/favicon.ico')).toEqual([]);
    } finally { udp.close(); }
  });

  it('requires the RTC guard when replaying scripts in children and after document replacement', async () => {
    const frame = await mount(`<p id="state"></p><button id="replace">Replace document</button>
      <script id="replay">document.querySelector('#state').textContent = typeof this.RTCPeerConnection;</script>
      <script>
        const sealed = document.querySelector('#replay').textContent;
        const script = '<script>' + sealed + '<' + '/script>';
        const child = document.createElement('iframe');
        child.srcdoc = '<p id="state"></p>' + script;
        document.body.append(child);
        document.querySelector('#replace').addEventListener('click', () => {
          document.open();
          document.write('<p id="state"></p><script>document.body.dataset.unsealed="yes";<' + '/script>' + script);
          document.close();
        });
      </script>`);
    const child = page.frames().find(child => child.parentFrame() === frame && child.url() === 'about:srcdoc');
    expect(child).toBeDefined();
    await expect.poll(() => child!.locator('#state').textContent()).toBe('undefined');
    await frame.locator('#replace').click();
    expect(await frame.locator('#state').textContent()).toBe('undefined');
    expect(await frame.locator('body').getAttribute('data-unsealed')).toBeNull();
    expect(probes.filter(path => path !== '/favicon.ico')).toEqual([]);
  });
});
