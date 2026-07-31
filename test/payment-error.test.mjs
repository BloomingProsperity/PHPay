import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  paymentFailureAction,
  paymentResourcePolicy,
  providerPaymentErrorCode,
  safePaymentErrorCode
} from '../src/payment-error.js';

test('card validation errors receive a user-safe error code', () => {
  assert.equal(safePaymentErrorCode(new Error('invalid card number')), 'invalid_card_data');
  assert.equal(safePaymentErrorCode(new Error('expired card')), 'invalid_card_data');
});

test('zero-price offers receive a dedicated non-payment error code', () => {
  assert.equal(safePaymentErrorCode(new Error('payment amount missing or zero')), 'zero_amount_offer');
});

test('unknown payment errors are not exposed verbatim', () => {
  assert.equal(safePaymentErrorCode(new Error('Bearer secret-token-should-not-appear')), 'payment_execution_failed');
  assert.equal(
    safePaymentErrorCode({ code: 'secret_token_should_not_appear', message: 'opaque provider failure' }),
    'payment_execution_failed'
  );
  assert.equal(
    providerPaymentErrorCode({ code: 'secret_token_should_not_appear' }),
    'payment_execution_failed'
  );
});

test('known payment error codes survive the strict allowlist', () => {
  for (const code of [
    'invalid_card_data',
    'zero_amount_offer',
    'insufficient_funds',
    'invalid_account_credential',
    'account_already_subscribed',
    'account_already_on_target_plan',
    'unsupported_target_plan',
    'account_status_check_failed',
    'cloudflare_challenge_failed',
    'payment_result_unknown',
    'promotional_offer_attached',
    'checkout_plan_mismatch',
    'checkout_upcoming_invoice_mismatch'
  ]) {
    assert.equal(safePaymentErrorCode({ code }), code);
  }
  for (const code of ['insufficient_funds', 'card_declined', 'expired_card', 'incorrect_cvc', 'processing_error', 'checkout_upcoming_invoice_mismatch']) {
    assert.equal(providerPaymentErrorCode({ code }), code);
  }
});

test('only known transport failures become proxy failures when a task actually uses a proxy', () => {
  assert.equal(
    safePaymentErrorCode({ code: 'UND_ERR_CONNECT_TIMEOUT' }, { hasProxy: true }),
    'proxy_connection_failed'
  );
  assert.equal(
    safePaymentErrorCode({ code: 'UND_ERR_CONNECT_TIMEOUT' }, { hasProxy: false }),
    'payment_execution_failed'
  );
  assert.equal(
    safePaymentErrorCode(new Error('proxy maybe slow'), { hasProxy: true }),
    'payment_execution_failed'
  );
  assert.equal(
    safePaymentErrorCode(
      new Error('request failed', { cause: { code: 'ECONNREFUSED' } }),
      { hasProxy: true }
    ),
    'proxy_connection_failed'
  );
  assert.equal(
    safePaymentErrorCode(
      new AggregateError([
        new Error('outer'),
        new Error('socket failed', { cause: { code: 'UND_ERR_SOCKET' } })
      ]),
      { hasProxy: true }
    ),
    'proxy_connection_failed'
  );
});

test('failure action keeps uncertain post-confirm results for reconciliation', () => {
  assert.equal(paymentFailureAction({
    state: 'unknown', stage: 'confirm_started', errorCode: 'proxy_connection_failed'
  }), 'reconcile');
  assert.equal(paymentFailureAction({
    state: 'pending_3ds', stage: 'confirm_started', errorCode: 'authentication_required'
  }), 'reconcile');
});

test('failure action switches only the resource identified by a definitive error', () => {
  assert.equal(paymentFailureAction({
    state: 'failed', stage: 'confirm_started', errorCode: 'insufficient_funds'
  }), 'next_card');
  assert.equal(paymentFailureAction({
    state: 'failed', stage: 'preconfirm', errorCode: 'incorrect_zip'
  }), 'next_address');
  assert.equal(paymentFailureAction({
    state: 'failed', stage: 'preconfirm', errorCode: 'proxy_connection_failed'
  }), 'next_proxy');
  assert.equal(paymentFailureAction({
    state: 'failed', stage: 'preconfirm', errorCode: 'payment_execution_failed'
  }), 'stop');
});

test('resource policy cools or blocks only cards that actually failed', () => {
  assert.deepEqual(paymentResourcePolicy({
    state: 'failed', stage: 'preconfirm', errorCode: 'incorrect_zip'
  }), { action: 'next_address', hold: false, card: 'available' });
  assert.deepEqual(paymentResourcePolicy({
    state: 'failed', stage: 'preconfirm', errorCode: 'proxy_connection_failed'
  }), { action: 'next_proxy', hold: false, card: 'available' });
  assert.deepEqual(paymentResourcePolicy({
    state: 'failed', stage: 'confirm_started', errorCode: 'card_declined'
  }), { action: 'next_card', hold: false, card: 'cooldown' });
  assert.deepEqual(paymentResourcePolicy({
    state: 'failed', stage: 'confirm_started', errorCode: 'insufficient_funds'
  }), { action: 'next_card', hold: false, card: 'blocked' });
  assert.deepEqual(paymentResourcePolicy({
    state: 'unknown', stage: 'confirm_started', errorCode: 'payment_result_unknown'
  }), { action: 'reconcile', hold: true, card: 'held' });
});

test('target-plan gate errors have explicit Chinese UI reasons', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(
    html,
    /account_already_on_target_plan'\) return '[^']*目标套餐[^']*停止/
  );
  assert.match(
    html,
    /unsupported_target_plan'\) return '[^']*套餐不受支持[^']*停止/
  );
});
