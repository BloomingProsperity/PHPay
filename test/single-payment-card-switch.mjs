import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const base = process.argv[2] || 'http://127.0.0.1:3456';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const accountId = 'accounts_aaaaaaaaaaaaaaaaaaaaaaaa';
const cardIds = ['cards_bbbbbbbbbbbbbbbbbbbbbbbb', 'cards_cccccccccccccccccccccccc'];
const cards = [
  { id: cardIds[0], masked: '•••• 4242', name: 'First Card', importedAt: '2026-01-01T00:00:00.000Z' },
  { id: cardIds[1], masked: '•••• 4444', name: 'Second Card', importedAt: '2026-01-02T00:00:00.000Z' }
];
const cardSecrets = {
  [cardIds[0]]: { number: '4242424242424242', exp: '12/30', cvc: '123', name: 'First Card' },
  [cardIds[1]]: { number: '5555555555554444', exp: '12/30', cvc: '456', name: 'Second Card' }
};
const attempts = [];

try {
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const send = body => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/api/accounts') return send([{ id: accountId, label: 'switch@example.com', importedAt: '2026-01-01T00:00:00.000Z', accountStatus: { state: 'free', plan: 'chatgptfreeplan' }, payment: null }]);
    if (url.pathname === '/api/cards') return send(cards);
    if (url.pathname === '/api/addresses') return send([]);
    if (url.pathname === '/api/payment-tasks' && request.method() === 'GET') return send([]);
    if (url.pathname === '/api/resources/accounts/use') return send({ accessToken: 'eyJhbGci.switch.access', user: { email: 'switch@example.com' } });
    if (url.pathname === '/api/resources/cards/use') {
      const { id } = request.postDataJSON();
      return send(cardSecrets[id]);
    }
    if (url.pathname === '/api/addresses/temporary') return send({ line1: '1 Main St', city: 'Seattle', state: 'WA', zip: '98101', country: 'US', temporary: true });
    if (url.pathname === '/api/payment-tasks' && request.method() === 'POST') {
      const payload = request.postDataJSON();
      attempts.push(payload);
      const insufficient = attempts.length === 1;
      return route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({
          id: `${attempts.length}`.padStart(8, '0') + '-1111-4111-8111-111111111111',
          state: insufficient ? 'failed' : 'succeeded',
          email: 'switch@example.com',
          cardLast4: payload.card.number.slice(-4),
          amount: 110000,
          currency: 'PHP',
          plan: payload.plan,
          verificationUrl: '',
          errorCode: insufficient ? 'insufficient_funds' : '',
          retryAction: insufficient ? 'next_card' : 'stop',
          stage: 'confirm_started',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        })
      });
    }
    return route.continue();
  });

  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('account-count')?.textContent === '1' && document.getElementById('card-count')?.textContent === '2');
  await page.evaluate(() => {
    for (const id of ['sess', 'num', 'exp', 'cvc', 'name', 'line1', 'city', 'state', 'zip', 'country']) document.getElementById(id).value = '';
  });
  await page.click('#pay');
  await page.waitForFunction(() => !document.getElementById('pay')?.disabled && document.getElementById('log')?.textContent.includes('状态：succeeded'));

  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].accountResourceId, attempts[1].accountResourceId);
  assert.deepEqual(attempts.map(attempt => attempt.cardResourceId), cardIds);
  console.log('PASS explicit insufficient_funds switches to the next card for the same account without a real charge');
} finally {
  await browser.close();
}
