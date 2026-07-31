export function classifyPaymentStatus(payload = {}) {
  const intent = payload.payment_intent || {};
  if (payload.payment_status === 'paid' || intent.status === 'succeeded') return { state: 'succeeded' };
  if (intent.status === 'requires_action') {
    return {
      state: 'pending_3ds',
      verificationUrl: safeVerificationUrl(intent.next_action?.redirect_to_url?.url)
    };
  }
  return { state: 'processing' };
}

function safeVerificationUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}
