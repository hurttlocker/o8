export async function ensureVisibleTerminal(page, tabs, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  let inventory = [];
  while (Date.now() < deadline) {
    inventory = await page.evaluate(() => Array.from(document.querySelectorAll('[data-o8-term-panel]')).map((panel) => ({
      sessionName: panel.getAttribute('data-o8-term-panel'),
      visible: getComputedStyle(panel).display !== 'none',
      ready: panel.querySelector('.xterm-helper-textarea') != null,
    })));
    const visible = inventory.find((entry) => entry.visible && entry.ready);
    if (visible) {
      const tab = tabs.find((entry) => entry.sessionName === visible.sessionName);
      if (tab) return { tab, mountedSessionNames: inventory.map((entry) => entry.sessionName).filter(Boolean) };
    }
    const candidate = inventory.find((entry) => entry.ready);
    const tab = tabs.find((entry) => entry.sessionName === candidate?.sessionName);
    if (tab) await page.locator(`[data-o8-workspace-tab="${tab.id}"]`).click().catch(() => undefined);
    await page.waitForTimeout(250);
  }
  throw new Error(`no ready visible terminal after ${timeoutMs}ms: ${JSON.stringify(inventory)}`);
}
