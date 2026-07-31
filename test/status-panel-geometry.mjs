import { chromium } from 'playwright-core';

const BASE = process.argv[2] || 'http://127.0.0.1:3457';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });

  const desktop = await page.evaluate(() => {
    const workspace = document.querySelector('.workspace').getBoundingClientRect();
    const wrap = document.querySelector('.wrap').getBoundingClientRect();
    const status = document.querySelector('.status-panel').getBoundingClientRect();
    const solverPanel = document.querySelector('[aria-labelledby="solver-title"]').getBoundingClientRect();
    const log = document.querySelector('#log').getBoundingClientRect();
    const success = document.querySelector('.success-pane').getBoundingClientRect();
    return {
      topGap: status.top - workspace.bottom,
      leftDelta: Math.abs(status.left - wrap.left),
      rightDelta: Math.abs(status.right - wrap.right),
      solverPanelHeight: solverPanel.height,
      statusTopDelta: Math.abs(log.top - success.top),
      statusBottomDelta: Math.abs(log.bottom - success.bottom)
    };
  });
  if (
    desktop.topGap < 15 || desktop.topGap > 25 ||
    desktop.leftDelta > 1 || desktop.rightDelta > 1 ||
    desktop.solverPanelHeight > 180 ||
    desktop.statusTopDelta > 1 || desktop.statusBottomDelta > 1
  ) {
    throw new Error(`desktop bottom status geometry is wrong: ${JSON.stringify(desktop)}`);
  }

  await page.setViewportSize({ width: 768, height: 1200 });
  const mobile = await page.evaluate(() => document.querySelector('.status-panel').getBoundingClientRect());
  if (mobile.height >= 600) {
    throw new Error(`mobile status panel is stretched to ${mobile.height}px`);
  }

  console.log(`PASS desktop=${JSON.stringify(desktop)}; mobile status height=${mobile.height}px`);
} finally {
  await browser.close();
}
