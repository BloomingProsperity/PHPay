import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const base = process.argv[2] || 'http://127.0.0.1:3456';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
let captured = null;

try {
  await page.route('**/api/payment-tasks', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    captured = route.request().postDataJSON();
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({
        id: '11111111-1111-4111-8111-111111111111',
        state: 'failed',
        email: 'test@example.com',
        cardLast4: String(captured.card?.number || '').slice(-4),
        amount: null,
        currency: '',
        plan: captured.plan,
        verificationUrl: '',
        errorCode: 'payment_execution_failed',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      })
    });
  });

  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() =>
    document.getElementById('account-count')?.textContent === '1' &&
    document.getElementById('card-count')?.textContent === '1'
  );
  await page.evaluate(() => {
    const plan = document.getElementById('plan');
    plan.value = 'chatgptplusplan';
    plan.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('sess').value = '';
    for (const id of ['num', 'exp', 'cvc', 'name']) document.getElementById(id).value = '';
  });
  await page.click('#pay');
  await page.waitForFunction(() => document.getElementById('log')?.textContent.includes('状态：failed'));

  assert.ok(captured);
  assert.match(captured.accountResourceId, /^accounts_[a-f0-9]{24}$/);
  assert.match(captured.cardResourceId, /^cards_[a-f0-9]{24}$/);
  assert.match(captured.sessionJson, /\S/);
  assert.match(captured.card.number, /^\d{13,19}$/);
  assert.match(captured.address.line1, /\S/);
  assert.equal(captured.plan, 'chatgptplusplan');
  console.log('PASS single payment auto-selects the current eligible account/card and prepares an address without charging');
} finally {
  await browser.close();
}
