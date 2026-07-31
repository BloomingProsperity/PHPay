import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyPaymentStatus } from '../src/payment-status.js';

test('requires_action becomes pending_3ds with a redirect URL', () => {
  assert.deepEqual(classifyPaymentStatus({
    payment_intent: {
      status: 'requires_action',
      next_action: { redirect_to_url: { url: 'https://verify.example/3ds' } }
    }
  }), { state: 'pending_3ds', verificationUrl: 'https://verify.example/3ds' });
});

test('a succeeded setup intent does not mark a payment successful', () => {
  assert.deepEqual(classifyPaymentStatus({ setup_intent: { status: 'succeeded' } }), { state: 'processing' });
});

test('a paid checkout becomes succeeded', () => {
  assert.deepEqual(classifyPaymentStatus({ payment_status: 'paid' }), { state: 'succeeded' });
});
