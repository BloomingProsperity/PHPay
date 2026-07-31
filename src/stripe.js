const STRIPE_VER = '2025-03-31.basil; checkout_server_update_beta=v1; checkout_manual_approval_preview=v1';
// 统一出口：Stripe 请求走代理（与 chatgpt 侧同源 IP，避免风控特征）。
// 支持按请求指定代理（代理池并行分配）；dispatcher 必须与 fetch 来自同一 undici 实例。
import { ProxyAgent, fetch as undiciFetch } from 'undici';
const ENV_PROXY = (process.env.HTTPS_PROXY || process.env.https_proxy || '').trim();
const STRIPE_REQUEST_TIMEOUT_MS = 20_000;
const agentCache = new Map();
function dispatcherFor(proxy) {
  if (!proxy) return null;
  let a = agentCache.get(proxy);
  if (!a) { a = new ProxyAgent(proxy); agentCache.set(proxy, a); }
  return a;
}
if (ENV_PROXY) console.log('[stripe] 出口代理:', ENV_PROXY);
export const BETAS = {
  'elements_session_client[client_betas][0]': 'custom_checkout_server_updates_1',
  'elements_session_client[client_betas][1]': 'custom_checkout_manual_approval_1',
  'elements_session_client[elements_init_source]': 'custom_checkout',
  'elements_session_client[referrer_host]': 'chatgpt.com'
};
export { STRIPE_VER };
async function call(path, params, method = 'POST', proxy) {
  // 显式代理（代理池按任务分配）优先，空值回落到全局 HTTPS_PROXY
  const dispatcher = dispatcherFor(proxy || ENV_PROXY);
  const url = 'https://api.stripe.com/v1' + path + (method === 'GET' ? '?' + new URLSearchParams(params).toString() : '');
  const r = await (dispatcher ? undiciFetch : globalThis.fetch)(url, {
    method,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: method === 'GET' ? undefined : new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(STRIPE_REQUEST_TIMEOUT_MS),
    ...(dispatcher ? { dispatcher } : {})
  });
  return { s: r.status, j: await r.json().catch(() => ({})) };
}
export function createPM(card, address, pk, proxy) {
  const [expM, expY] = String(card.exp).split('/').map(s => s.trim());
  return call('/payment_methods', {
    type: 'card',
    'card[number]': String(card.number).replace(/\D/g, ''),
    'card[cvc]': String(card.cvc).trim(),
    'card[exp_month]': expM,
    'card[exp_year]': '20' + String(expY).slice(-2),
    'billing_details[name]': card.name || '',
    'billing_details[address][line1]': address.line1,
    'billing_details[address][city]': address.city,
    'billing_details[address][state]': address.state,
    'billing_details[address][postal_code]': address.zip,
    'billing_details[address][country]': address.country,
    allow_redisplay: 'always',
    payment_user_agent: 'stripe.js/5f12795ce5; stripe-js-v3/5f12795ce5; payment-element; deferred-intent',
    referrer: 'https://chatgpt.com',
    key: pk
  }, 'POST', proxy);
}
export function init(cs, pk, proxy) {
  return call('/payment_pages/' + cs + '/init', {
    key: pk, _stripe_version: STRIPE_VER, ...BETAS,
    'elements_session_client[stripe_js_id]': crypto.randomUUID(),
    'elements_session_client[locale]': 'en',
    'elements_session_client[is_aggregation_expected]': 'false',
    'elements_options_client[saved_payment_method][enable_save]': 'auto',
    'elements_options_client[saved_payment_method][enable_redisplay]': 'auto',
    browser_locale: 'en-US', browser_timezone: 'Asia/Shanghai'
  }, 'POST', proxy);
}
export function confirm(cs, pmId, checksum, due, entity, planType, pk, proxy) {
  return call('/payment_pages/' + cs + '/confirm', {
    payment_method: pmId,
    init_checksum: checksum,
    expected_amount: String(due),
    expected_payment_method_type: 'card',
    return_url: `https://chatgpt.com/checkout/verify?stripe_session_id=${cs}&processor_entity=${entity}&plan_type=${planType}`,
    'elements_session_client[client_betas][0]': 'custom_checkout_server_updates_1',
    'elements_session_client[client_betas][1]': 'custom_checkout_manual_approval_1',
    'consent[terms_of_service]': 'accepted',
    key: pk, _stripe_version: STRIPE_VER
  }, 'POST', proxy);
}
export function pollSession(cs, pk, proxy) {
  return call('/payment_pages/' + cs, { key: pk, _stripe_version: STRIPE_VER, ...BETAS }, 'GET', proxy);
}
