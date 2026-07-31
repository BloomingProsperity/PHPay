const SAFE_PAYMENT_CODES = new Set([
  'payment_execution_failed',
  'actual_amount_unavailable',
  'payment_result_unknown',
  'promotional_offer_attached',
  'checkout_plan_mismatch',
  'checkout_upcoming_invoice_mismatch',
  'zero_amount_offer',
  'invalid_card_data',
  'insufficient_funds',
  'invalid_account_credential',
  'account_already_subscribed',
  'account_already_on_target_plan',
  'unsupported_target_plan',
  'account_status_check_failed',
  'account_completion_failed',
  'observer_internal_error',
  'account_resource_not_found',
  'cloudflare_challenge_failed',
  'proxy_connection_failed',
  'card_declined',
  'expired_card',
  'incorrect_cvc',
  'invalid_cvc',
  'incorrect_number',
  'invalid_number',
  'incorrect_address',
  'invalid_address',
  'incorrect_zip',
  'invalid_postal_code',
  'processing_error'
]);

const SAFE_PROVIDER_CODES = new Set([
  'insufficient_funds',
  'card_declined',
  'expired_card',
  'incorrect_cvc',
  'invalid_cvc',
  'incorrect_number',
  'invalid_number',
  'processing_error',
  'authentication_required',
  'payment_intent_authentication_failure',
  'incorrect_address',
  'invalid_address',
  'incorrect_zip',
  'invalid_postal_code',
  'checkout_upcoming_invoice_mismatch'
]);

const PROXY_TRANSPORT_CODES = new Set([
  'und_err_connect_timeout',
  'und_err_socket',
  'econnreset',
  'econnrefused',
  'etimedout',
  'enotfound',
  'eai_again'
]);

const CARD_FAILURE_CODES = new Set([
  'invalid_card_data',
  'insufficient_funds',
  'card_declined',
  'expired_card',
  'incorrect_cvc',
  'invalid_cvc',
  'incorrect_number',
  'invalid_number',
  'processing_error',
  'payment_intent_authentication_failure'
]);

const ADDRESS_FAILURE_CODES = new Set([
  'incorrect_address',
  'invalid_address',
  'incorrect_zip',
  'invalid_postal_code'
]);

const CONFIRM_OR_LATER = new Set(['confirm_started', 'approve_started', 'polling']);

export function safePaymentErrorCode(error, context = {}) {
  const explicit = String(error?.code || '').toLowerCase();
  if (SAFE_PAYMENT_CODES.has(explicit)) return explicit;
  if (context.hasProxy === true && transportErrorCodes(error).some(code => PROXY_TRANSPORT_CODES.has(code))) {
    return 'proxy_connection_failed';
  }
  const message = String(error?.message || '').toLowerCase();
  if (message.includes('invalid card number') || message.includes('invalid expiration') || message.includes('expired card') || message.includes('invalid security code')) return 'invalid_card_data';
  if (message.includes('payment amount missing or zero')) return 'zero_amount_offer';
  if (message.includes('invalid account credential') || message.includes('no recognizable account credential')) return 'invalid_account_credential';
  return 'payment_execution_failed';
}

function transportErrorCodes(error, seen = new Set(), depth = 0) {
  if (!error || typeof error !== 'object' || seen.has(error) || depth > 8) return [];
  seen.add(error);
  const codes = [String(error.code || '').toLowerCase()].filter(Boolean);
  if (error.cause) codes.push(...transportErrorCodes(error.cause, seen, depth + 1));
  if (Array.isArray(error.errors)) {
    for (const nested of error.errors) {
      codes.push(...transportErrorCodes(nested, seen, depth + 1));
    }
  }
  return codes;
}

export function providerPaymentErrorCode(error = {}) {
  const declineCode = String(error.decline_code || '').toLowerCase();
  if (SAFE_PROVIDER_CODES.has(declineCode)) return declineCode;
  const code = String(error.code || '').toLowerCase();
  return SAFE_PROVIDER_CODES.has(code) ? code : 'payment_execution_failed';
}

export function paymentFailureAction({ state = '', stage = '', errorCode = '' } = {}) {
  const normalizedState = String(state || '').toLowerCase();
  const normalizedStage = String(stage || '').toLowerCase();
  const code = String(errorCode || '').toLowerCase();

  if (
    normalizedState === 'pending_3ds'
    || normalizedState === 'unknown'
    || code === 'authentication_required'
  ) {
    return 'reconcile';
  }
  if (normalizedState !== 'failed') {
    return CONFIRM_OR_LATER.has(normalizedStage) ? 'reconcile' : 'stop';
  }
  if (CARD_FAILURE_CODES.has(code)) return 'next_card';
  if (!CONFIRM_OR_LATER.has(normalizedStage) && ADDRESS_FAILURE_CODES.has(code)) return 'next_address';
  if (!CONFIRM_OR_LATER.has(normalizedStage) && code === 'proxy_connection_failed') return 'next_proxy';
  return 'stop';
}

export function paymentResourcePolicy(task = {}) {
  const action = paymentFailureAction(task);
  const code = String(task?.errorCode || '').toLowerCase();
  if (action === 'reconcile') {
    return { action, hold: true, card: 'held' };
  }
  if (code === 'insufficient_funds') {
    return { action, hold: false, card: 'blocked' };
  }
  if (action === 'next_card') {
    return { action, hold: false, card: 'cooldown' };
  }
  return { action, hold: false, card: 'available' };
}
