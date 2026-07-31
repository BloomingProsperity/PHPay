import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('every Stripe request has a bounded timeout', () => {
  const source = fs.readFileSync(new URL('../src/stripe.js', import.meta.url), 'utf8');
  assert.match(source, /signal:\s*AbortSignal\.timeout\(STRIPE_REQUEST_TIMEOUT_MS\)/);
  assert.match(source, /const STRIPE_REQUEST_TIMEOUT_MS = 20_000/);
});
