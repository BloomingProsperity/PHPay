import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const base = process.argv[2] || 'http://127.0.0.1:3456';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
let detectedAccounts = [];

try {
  await page.route('**/api/accounts', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(detectedAccounts)
    });
  });
  await page.route('**/api/resources/accounts/detect-import', async route => {
    detectedAccounts = [{
      id: 'accounts_dddddddddddddddddddddddd',
      label: 'detected@example.com',
      importedAt: '2026-07-31T00:00:00.000Z',
      accountStatus: { state: 'free', plan: 'chatgptfreeplan', errorCode: '' },
      payment: null
    }];
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        added: 1,
        duplicate: 0,
        rejected: 0,
        items: detectedAccounts
      })
    });
  });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(200);

  const solverPanel = page.locator('section[aria-labelledby="solver-title"]');
  const solverSettings = page.locator('#solver-settings');
  assert.equal((await page.locator('#solver-title').textContent()).trim(), '验证服务');
  assert.equal(await solverSettings.isVisible(), true);
  assert.equal(await solverPanel.locator('[aria-controls="solver-settings"]').count(), 0);
  for (const id of [
    'solver-key', 'solver-ws', 'solvertest', 'solversave',
    'proxy-editor', 'proxy-save', 'proxy-import', 'proxy-clear'
  ]) {
    assert.equal(await page.locator(`#${id}`).count(), 1, `missing control #${id}`);
  }
  assert.equal(await page.locator('#fingerprint-stat,#fingerprint-list,#fingerprint-manage').count(), 0);
  assert.equal(await page.locator('#account-detect-import').count(), 1);
  await page.locator('#sess').fill(JSON.stringify({
    accessToken: 'eyJhbGci.detected.account',
    user: { email: 'detected@example.com' }
  }));
  await page.locator('#account-detect-import').click();
  await page.waitForFunction(() => document.getElementById('account-count')?.textContent === '1');
  await page.waitForFunction(() => document.getElementById('account-detect-result')?.textContent.includes('detected@example.com'));
  assert.match(await page.locator('#account-detect-result').textContent(), /detected@example\.com/);

  const solverColumns = await solverSettings.evaluate(element => getComputedStyle(element).gridTemplateColumns);
  assert.equal(solverColumns.trim().split(/\s+/).length, 1);
  for (const card of await solverSettings.locator('.validation-card').all()) {
    const color = await card.evaluate(element => getComputedStyle(element).backgroundColor);
    assert.notEqual(color, 'rgb(255, 255, 255)');
    assert.notEqual(color, 'rgba(0, 0, 0, 0)');
  }

  const workspace = await page.locator('.workspace').boundingBox();
  const status = await page.locator('.status-panel').boundingBox();
  assert.ok(workspace && status);
  assert.ok(status.y >= workspace.y + workspace.height - 1, 'status panel must stay below the workspace');

  await page.setViewportSize({ width: 827, height: 900 });
  const resourcePanel = await page.locator('section[aria-labelledby="resource-title"]').boundingBox();
  const validationPanel = await solverPanel.boundingBox();
  const threeDsPanel = await page.locator('.three-ds-panel').boundingBox();
  assert.ok(resourcePanel && validationPanel && threeDsPanel);
  assert.ok(Math.abs(resourcePanel.y - validationPanel.y) < 2, 'resource and validation panels should align');
  assert.ok(threeDsPanel.y >= Math.max(
    resourcePanel.y + resourcePanel.height,
    validationPanel.y + validationPanel.height
  ) - 1);
  const statusColumns = await page.locator('.status-content').evaluate(element => (
    getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/).length
  ));
  assert.equal(statusColumns, 2);

  await page.setViewportSize({ width: 360, height: 900 });
  for (const selector of [
    '.task-card', 'section[aria-labelledby="resource-title"]',
    'section[aria-labelledby="solver-title"]', '.three-ds-panel', '.status-panel'
  ]) {
    const box = await page.locator(selector).boundingBox();
    assert.ok(box, `missing ${selector}`);
    assert.ok(box.x >= -1, `${selector} overflows the left edge`);
    assert.ok(box.x + box.width <= 361, `${selector} overflows the right edge`);
  }

  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.locator('#payment-details summary').click();
  await page.locator('#exp').fill('0629');
  assert.equal(await page.locator('#exp').inputValue(), '06/29');

  await page.locator('#account-resource .resource-import').click();
  await page.waitForSelector('#modal-mask.show');
  assert.equal(await page.locator('#modal-close').count(), 1);
  assert.equal(await page.locator('#modal-close').getAttribute('aria-label'), '关闭弹窗');
  assert.equal(await page.locator('#resource-file-picker').getAttribute('accept'), '*/*');
  assert.equal(await page.locator('[data-resource-template="accounts"]').count(), 0);
  assert.equal(await page.locator('#modal-items button:has-text("开始导入（0 个文件）")').isDisabled(), true);
  await page.locator('#modal-close').click();

  for (const kind of ['cards', 'addresses']) {
    const section = kind === 'cards' ? 'card' : 'address';
    await page.locator(`#${section}-resource .resource-import`).click();
    assert.equal(await page.locator(`[data-resource-template="${kind}"]`).count(), 1);
    await page.locator('#modal-close').click();
  }

  const source = fs.readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8');
  assert.match(source, /fetch\('\/api\/payment-tasks', \{ method: 'POST'/);
  assert.match(source, /fetch\('\/api\/payment-tasks\/batch'/);
  assert.doesNotMatch(source, /function paymentFailureAction\s*\(/);
  assert.match(source, /task\.retryAction/);
  assert.match(source, /next_card/);
  assert.match(source, /next_address/);
  assert.match(source, /next_proxy/);
  assert.match(source, /proxy\.healthy/);
  assert.match(source, /waiting\.proxy/);
  assert.doesNotMatch(source, /id="fingerprint-(?:stat|list|manage)"/);
  assert.doesNotMatch(source, /指纹：|软复用/);
  assert.match(source, /id="three-ds-pending"/);
  assert.match(source, /id="three-ds-completed"/);
  assert.doesNotMatch(source, /id="account-resource"[\s\S]{0,800}id="bulk"/);
  assert.doesNotMatch(source, /Cloudflare 挑战自动过盾（默认本地浏览器，零配置）/);
  assert.doesNotMatch(source, /\/api\/pay\?payload=/);
  console.log('PASS compact account detection, scheduling and 3DS UI');
} finally {
  await browser.close();
}
