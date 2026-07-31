import test from 'node:test';
import assert from 'node:assert/strict';
import { extractActualAmount, validateCard, recordActualAmount } from '../src/payment.js';
import { providerPaymentErrorCode, safePaymentErrorCode } from '../src/payment-error.js';

test('validateCard supplies a one-time name when a valid card omits it', () => {
  const card = validateCard({ number: '4242424242424242', exp: '12/30', cvc: '123', name: '' });
  assert.match(card.name, /\S+\s+\S+/);
});

test('provider decline code preserves insufficient funds for automatic card switching', () => {
  assert.equal(providerPaymentErrorCode({ code: 'card_declined', decline_code: 'insufficient_funds' }), 'insufficient_funds');
  assert.equal(providerPaymentErrorCode({ code: 'expired_card' }), 'expired_card');
});

test('zero actual amount is surfaced as a dedicated non-payment result', () => {
  assert.equal(safePaymentErrorCode({ code: 'zero_amount_offer', message: 'actual amount is zero' }), 'zero_amount_offer');
});

test('zero actual amount is recorded before payment is stopped', () => {
  let observed = null;
  assert.throws(() => recordActualAmount(0, 'PHP', { onAmount: value => { observed = value; } }), error => error.code === 'zero_amount_offer');
  assert.deepEqual(observed, { amount: 0, currency: 'PHP' });
});

test('actual amount accepts only a safe non-negative invoice amount_due', () => {
  assert.equal(extractActualAmount({ j: { invoice: { amount_due: 99900 } } }), 99900);
  for (const init of [
    { j: { total_summary: { due: 99900, total: 99900 } } },
    { j: { invoice: {} } },
    { j: { invoice: { amount_due: -1 } } },
    { j: { invoice: { amount_due: 1.5 } } },
    { j: { invoice: { amount_due: Number.MAX_SAFE_INTEGER + 1 } } }
  ]) {
    assert.throws(
      () => extractActualAmount(init),
      error => error?.code === 'actual_amount_unavailable'
    );
  }
});

test('validateCard rejects a Luhn-invalid card number', () => {
  assert.throws(() => validateCard({ number: '4242424242424241', exp: '12/30', cvc: '123' }), /card number/i);
});

test('validateCard rejects an impossible expiration month', () => {
  assert.throws(() => validateCard({ number: '4242424242424242', exp: '13/30', cvc: '123' }), /expiration/i);
});

test('validateCard rejects an expired card', () => {
  assert.throws(() => validateCard({ number: '4242424242424242', exp: '01/20', cvc: '123' }), /expired/i);
});
