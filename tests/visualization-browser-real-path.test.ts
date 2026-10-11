import { createServer, type Server } from 'node:http';
import { createSocket } from 'node:dgram';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultVisualizationTheme, visualizationSrcdoc } from '@/lib/visualizations/document';
import { parseVisualizationLayout, visualizationLayoutHtml } from '@/lib/visualizations/templates';

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

  async function mount(html: string, state: Record<string, unknown> = {}) {
    await page.goto(base);
    // Attach inspection to the opaque outer target before it creates its nested content frame.
    await page.locator('#visual').evaluate(frame => {
      (frame as HTMLIFrameElement).srcdoc = '<p data-fixture-ready>Ready</p>';
    });
    await page.frameLocator('#visual').locator('[data-fixture-ready]').waitFor();
    probes = [];
    await page.evaluate(srcdoc => {
      const frame = document.querySelector<HTMLIFrameElement>('#visual')!;
      frame.srcdoc = srcdoc;
      (window as unknown as { heights: number[] }).heights = [];
      addEventListener('message', event => {
        if (event.source === frame.contentWindow && event.data?.type === 'o8-visualization:height') (window as unknown as { heights: number[] }).heights.push(event.data.height);
      });
    }, await visualizationSrcdoc(html, 'fixture', defaultVisualizationTheme(), state));
    await page.waitForFunction(() => (window as unknown as { heights: number[] }).heights.length > 0);
    await expect.poll(() => page.frames().some(frame => frame.parentFrame()?.parentFrame() === page.mainFrame())).toBe(true);
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

  it('keeps natural height stable when a final paragraph has a collapsing margin', async () => {
    await mount('<section style="height:240px"></section><p style="margin:0 0 20px">A final note</p>');
    await page.evaluate(() => {
      const frame = document.querySelector<HTMLIFrameElement>('#visual')!;
      addEventListener('message', event => {
        if (event.source === frame.contentWindow && event.data?.type === 'o8-visualization:height') frame.style.height = `${event.data.height}px`;
      });
      frame.style.height = `${(window as unknown as { heights: number[] }).heights.at(-1)}px`;
    });
    await page.waitForTimeout(200);
    const before = await page.evaluate(() => (window as unknown as { heights: number[] }).heights.length);
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => (window as unknown as { heights: number[] }).heights.length)).toBe(before);
    expect(await page.evaluate(() => (window as unknown as { heights: number[] }).heights.at(-1))).toBeGreaterThan(280);
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

  it('explores shared chart values with a moving bounded tooltip, keyboard and touch-style pinning', async () => {
    const frame = await mount(`<div id="chart"></div><script>window.chart=o8Viz.chart('#chart',{xLabel:'Day',yLabel:'Tasks',series:[
      {id:'build',label:'Build',values:[{x:1,y:2},{x:2,y:9},{x:3,y:5}]},
      {id:'review',label:'Review',values:[{x:1,y:4},{x:2,y:null},{x:3,y:6}]}]});</script>`);
    const hit = frame.locator('[data-chart-hit]'), bounds = (await hit.boundingBox())!;
    await page.mouse.move(bounds.x + bounds.width * .35, bounds.y + 45);
    const first = (await frame.locator('.viz-tooltip').boundingBox())!;
    expect(await frame.locator('.viz-tooltip').textContent()).toContain('≈');
    expect(await frame.locator('.viz-tooltip').textContent()).toContain('—');
    await page.mouse.move(bounds.x + bounds.width * .55, bounds.y + 45);
    expect((await frame.locator('.viz-tooltip').boundingBox())!.x).not.toBe(first.x);
    await hit.focus(); await hit.press('Home'); await hit.press('ArrowRight');
    expect(await frame.locator('.viz-sr-only').textContent()).toContain('Build: 9');
    expect(await frame.evaluate(() => (window as unknown as { chart: { selected(): unknown } }).chart.selected())).toMatchObject({ x: 2, series: [{ id: 'build', value: 9 }, { id: 'review', value: null }] });
    await hit.press('Escape'); expect(await frame.locator('.viz-tooltip').isVisible()).toBe(false);
    await hit.dispatchEvent('pointerdown', { pointerType: 'touch', clientX: bounds.x + bounds.width / 2, clientY: bounds.y + 45 });
    await hit.dispatchEvent('pointerleave'); expect(await frame.locator('.viz-tooltip').isVisible()).toBe(true);
    await frame.locator('summary').click();
    expect(await frame.locator('tbody tr').count()).toBe(3);
    expect(await frame.locator('tbody tr').nth(1).textContent()).toContain('9—');
  });

  it('restores saved tabs and series choices, forwards questions, and reflows axes without horizontal overflow', async () => {
    const frame = await mount(`<div id="measure" class="viz-tabs" data-viz-tabs data-state-key="measure" aria-label="Measure"><button data-value="tasks">Tasks</button><button data-value="minutes">Minutes</button></div>
      <div id="chart"></div><button id="ask" class="viz-button">Investigate</button><script>
        o8Viz.chart('#chart',{xLabel:'Day',yLabel:'Tasks',series:[{id:'build',label:'Build',values:[{x:1,y:2},{x:2,y:9}]},{id:'review',label:'Review',values:[{x:1,y:4},{x:2,y:6}]}]});
        document.querySelector('#ask').addEventListener('click',()=>o8Viz.ask('Explain the selected result'));</script>`, { measure: 'minutes', charts: { chart: { hidden: ['review'] } } });
    expect(await frame.locator('[data-value="minutes"]').getAttribute('aria-selected')).toBe('true');
    expect(await frame.locator('[data-series="review"]').getAttribute('aria-pressed')).toBe('false');
    await frame.locator('[data-value="minutes"]').press('ArrowLeft');
    expect(await frame.locator('[data-value="tasks"]').getAttribute('aria-selected')).toBe('true');
    await page.evaluate(() => { (window as unknown as { questions: string[] }).questions = []; addEventListener('message', e => { if (e.data?.type === 'o8-visualization:question') (window as unknown as { questions: string[] }).questions.push(e.data.value); }); });
    await frame.locator('#ask').click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { questions: string[] }).questions)).toEqual(['Explain the selected result']);
    for (const width of [320, 480, 1024]) {
      await page.locator('#visual').evaluate((node, width) => { (node as HTMLElement).style.width = width + 'px'; }, width);
      await frame.waitForFunction(expected => document.querySelector('svg')?.getAttribute('viewBox')?.split(' ')[2] === String(expected), width);
      expect(await frame.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    }
  });

  it('keeps empty and single-value charts visible and handles negative grouped bars', async () => {
    const frame = await mount(`<div id="empty"></div><div id="single"></div><div id="bars"></div><script>
      o8Viz.chart('#empty',{series:[]});
      o8Viz.chart('#single',{series:[{id:'one',values:[{x:1,y:3}]}]});
      o8Viz.chart('#bars',{type:'bar',series:[{id:'change',label:'Change',values:[{x:1,y:-2},{x:2,y:3}]}]});</script>`);
    expect(await frame.locator('#empty').textContent()).toContain('No data to display');
    expect(await frame.locator('#single svg circle').count()).toBe(1);
    const heights = await frame.locator('#bars svg rect').evaluateAll(nodes => nodes.map(node => Number(node.getAttribute('height'))));
    expect(heights).toHaveLength(2); expect(heights.every(value => value > 0)).toBe(true);
    const hit = frame.locator('#bars [data-chart-hit]'); await hit.focus(); await hit.press('Home');
    expect(await frame.locator('#bars .viz-sr-only').textContent()).toContain('Change: −2');
  });

  it('links a series and day across chart, heatmap, details and values without losing context', async () => {
    const spec = parseVisualizationLayout({ layout: 'explore', title: 'Weekly work', source: 'Illustrative fixture', unit: 'tasks', xLabel: 'Day',
      series: [{ id: 'build', label: 'Build', values: [{ x: 1, y: 4, label: 'Mon' }, { x: 2, y: 8, label: 'Tue' }] },
        { id: 'review', label: 'Review', values: [{ x: 1, y: 2, label: 'Mon' }, { x: 2, y: null, label: 'Tue' }] }] });
    const frame = await mount(visualizationLayoutHtml(spec));
    await frame.locator('[data-filter-series="review"]').click();
    expect(await frame.locator('[data-filter-series="review"]').getAttribute('aria-pressed')).toBe('true');
    expect(await frame.locator('thead').last().textContent()).toContain('Review (tasks)');
    expect(await frame.locator('thead').last().textContent()).not.toContain('Build');
    await frame.locator('[data-heat-series="review"][data-heat-x="2"]').click();
    expect(await frame.locator('.viz-grid .viz-value').first().textContent()).toBe('—');
    await frame.locator('[data-heat-series="build"][data-heat-x="2"]').click();
    expect(await frame.locator('.viz-selection').textContent()).toContain('Build · Tue');
    expect(await frame.locator('svg [data-chart-x="2"]').evaluate(node => getComputedStyle(node).display)).not.toBe('none');
    expect(await frame.locator('.viz-detail').textContent()).toContain('1 recorded value.');
    await frame.locator('summary').last().click();
    expect(await frame.locator('tbody').last().locator('tr').count()).toBe(1);
    expect(await frame.locator('tbody').last().textContent()).toContain('Tue8');
    await frame.getByRole('button', { name: 'Clear selection', exact: true }).click();
    expect(await frame.locator('tbody').last().locator('tr').count()).toBe(2);
    for (const width of [320, 480, 1024]) {
      await page.locator('#visual').evaluate((node, width) => { (node as HTMLElement).style.width = width + 'px'; }, width);
      await frame.waitForFunction(expected => document.documentElement.clientWidth === expected, width);
      await frame.waitForFunction(expected => document.querySelector('svg')?.getAttribute('viewBox')?.split(' ')[2] === String(expected), width);
      expect(await frame.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    }
  });

  it('retains linked choices and open values when the same data receives a quieter revision', async () => {
    const spec = parseVisualizationLayout({ layout: 'explore', title: 'Revision fixture', source: 'Illustrative fixture', unit: 'tasks', xLabel: 'Day',
      series: [{ id: 'build', label: 'Build', values: [{ x: 1, y: 4, label: 'Mon' }, { x: 2, y: 8, label: 'Tue' }] },
        { id: 'review', label: 'Review', values: [{ x: 1, y: 2, label: 'Mon' }, { x: 2, y: null, label: 'Tue' }] }] });
    const first = await mount(visualizationLayoutHtml(spec));
    await first.locator('[data-heat-series="build"][data-heat-x="2"]').click();
    await first.getByRole('button', { name: 'Compare', exact: true }).click(); await first.locator('.viz-dashboard > details summary').click();
    await first.waitForFunction(() => (window as unknown as { o8Viz: { getState(): { dashboards?: { exploration?: { valuesOpen?: boolean } } } } }).o8Viz.getState().dashboards?.exploration?.valuesOpen === true);
    const state = await first.evaluate(() => (window as unknown as { o8Viz: { getState(): Record<string, unknown> } }).o8Viz.getState());
    const revised = await mount(visualizationLayoutHtml({ ...spec, style: 'quiet', density: 'compact' }), state);
    expect(await revised.locator('.viz-selection').textContent()).toContain('Build · Tue');
    expect(await revised.getByRole('button', { name: 'Compare', exact: true }).getAttribute('aria-pressed')).toBe('true');
    expect(await revised.locator('.viz-dashboard > details').getAttribute('open')).not.toBeNull();
    expect(await revised.locator('.viz-dashboard > details tbody tr').count()).toBe(1); expect(await revised.locator('svg rect').count()).toBe(2);
    expect(await revised.locator('body').textContent()).toContain('Illustrative fixture');
  });

  it('bounds sparse heatmap rendering and reaches every day without truncating the linked values', async () => {
    const spec = parseVisualizationLayout({ layout: 'explore', title: 'A longer timeline', source: 'Sparse illustrative fixture', unit: 'tasks', xLabel: 'Day',
      series: [{ id: 'build', label: 'Build', values: Array.from({ length: 80 }, (_, i) => ({ x: i + 1, y: i, label: 'D' + (i + 1) })) },
        { id: 'review', label: 'Review', values: Array.from({ length: 80 }, (_, i) => ({ x: i + 81, y: i, label: 'D' + (i + 81) })) }] });
    const frame = await mount(visualizationLayoutHtml(spec));
    expect(await frame.locator('[data-heat-x]').count()).toBe(84);
    await frame.getByRole('button', { name: 'Next pattern page', exact: true }).click();
    expect(await frame.locator('[data-heat-x]').first().getAttribute('data-heat-x')).toBe('43');
    const hit = frame.locator('[data-chart-hit]'); await hit.focus(); await hit.press('End'); await hit.press('Enter');
    expect(await frame.locator('.viz-selection').textContent()).toContain('D160');
    expect(await frame.locator('[data-heat-x="160"]').count()).toBe(2);
    await frame.getByRole('button', { name: 'Clear selection', exact: true }).click();
    await frame.locator('.viz-dashboard > details summary').click();
    expect(await frame.locator('.viz-dashboard > details tbody tr').count()).toBe(60);
    expect(await frame.locator('.viz-dashboard > details tbody').textContent()).toContain('D160');
    expect(await frame.locator('[data-heat-x]').count()).toBeLessThanOrEqual(84);
  });

  it('asks about the visible selection when a revision removes saved series or days', async () => {
    const spec = parseVisualizationLayout({ layout: 'explore', title: 'Changed data', source: 'Illustrative fixture', unit: 'tasks', xLabel: 'Day',
      series: [{ id: 'build', label: 'Build', values: [{ x: 1, y: 4, label: 'Mon' }, { x: 2, y: 8, label: 'Tue' }] },
        { id: 'review', label: 'Review', values: [{ x: 1, y: 2, label: 'Mon' }] }] });
    const frame = await mount(visualizationLayoutHtml(spec), { links: { exploration: { seriesId: 'removed', x: 999 } } });
    await page.evaluate(() => {
      (window as unknown as { question: string }).question = '';
      addEventListener('message', event => { if (event.data?.type === 'o8-visualization:question') (window as unknown as { question: string }).question = event.data.value; });
    });
    expect(await frame.locator('.viz-selection').textContent()).toContain('All series · Full range');
    await frame.getByRole('button', { name: 'Ask about this selection', exact: true }).click();
    await page.waitForFunction(() => Boolean((window as unknown as { question: string }).question));
    const question = await page.evaluate(() => (window as unknown as { question: string }).question);
    expect(question).toContain('all Day');
    expect(question).toContain('Build: 12 tasks (sum, 2 recorded, 0 missing)');
    expect(question).toContain('Review: 2 tasks (sum, 1 recorded, 1 missing)');
    expect(question).not.toContain('undefined');
  });

  it('keeps the largest sparse layout bounded and usable at narrow widths in both themes', async () => {
    const spec = parseVisualizationLayout({ layout: 'explore', title: 'A longer cross-series investigation', source: 'Maximum-size illustrative fixture', unit: 'tasks', xLabel: 'Day',
      series: Array.from({ length: 8 }, (_, series) => ({ id: `series-${series}`, label: `Workstream ${series + 1}`, values: Array.from({ length: 366 }, (_, index) => ({ x: series * 366 + index + 1, y: index % 11 === 0 ? null : index - 100, label: `Day ${series * 366 + index + 1}` })) })) });
    const frame = await mount(visualizationLayoutHtml(spec));
    for (const appearance of ['light', 'dark'] as const) {
      await page.evaluate(theme => document.querySelector<HTMLIFrameElement>('#visual')!.contentWindow!.postMessage({ type: 'o8-visualization:theme', nonce: 'fixture', theme }, '*'), defaultVisualizationTheme(appearance));
      await frame.waitForFunction(expected => document.documentElement.dataset.theme === expected, appearance);
      for (const width of [320, 480, 1024]) {
        await page.locator('#visual').evaluate((node, width) => { (node as HTMLElement).style.width = width + 'px'; }, width);
        await frame.waitForFunction(expected => document.documentElement.clientWidth === expected, width);
        expect(await frame.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
        expect(await frame.locator('[data-heat-x]').count()).toBeLessThanOrEqual(8 * 42);
      }
    }
    const hit = frame.locator('[data-chart-hit]'); await hit.focus(); await hit.press('End'); await hit.press('Enter');
    expect(await frame.locator('.viz-selection').textContent()).toContain('Day 2928');
    expect(await hit.evaluate(node => document.activeElement === node)).toBe(true);
    await hit.press('Escape'); expect(await frame.locator('.viz-selection').textContent()).toContain('Full range');
    await frame.locator('.viz-dashboard > details summary').click();
    expect(await frame.locator('.viz-dashboard > details tbody tr').count()).toBeLessThanOrEqual(100);
    expect(await frame.locator('.viz-dashboard > details tbody').textContent()).toContain('Day 2928');
  });
});
