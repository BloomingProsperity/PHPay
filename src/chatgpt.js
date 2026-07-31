import { cgFetch } from './browser.js';
import { requirementsToken, extractBuildNo } from './turnstile.js';
export const PLANS = {
  chatgptgoplan: { label: 'Go', planType: 'go' },
  chatgptplusplan: { label: 'Plus', planType: 'plus' },
  chatgptpro: { label: 'Pro 20x', planType: 'pro' },
  chatgptprolite: { label: 'Pro 5x', planType: 'pro' },
  chatgptteamplan: { label: 'Team', planType: 'business' }
};
// requirement token（turnstile dx 的 XOR 密钥）缓存 5 分钟
let reqTokenCache = { token: '', ts: 0 };
async function getReqToken(opts) {
  if (Date.now() - reqTokenCache.ts < 300e3 && reqTokenCache.token) return reqTokenCache.token;
  let buildNo = '';
  try {
    const home = await cgFetch('/', opts);
    buildNo = extractBuildNo(home.json?.raw || '') || extractBuildNo(JSON.stringify(home.json || {})) || '';
  } catch {}
  const token = requirementsToken(buildNo || 'prod');
  reqTokenCache = { token, ts: Date.now() };
  return token;
}
// opts: { proxy, imp } — 并行任务各自分配出口代理与 TLS 指纹
export async function createSession(token, { plan = 'chatgptpro', country = 'PH', currency = 'PHP', entryPoint = 'billing_page', proxy = '', imp = '', skipPromo = true } = {}) {
  return cgFetch('/backend-api/payments/checkout', {
    method: 'POST', token, proxy, imp,
    body: {
      entry_point: entryPoint,
      plan_name: plan,
      billing_details: { country, currency },
      checkout_ui_mode: 'hosted',
      // 实测验证：eligible 账号服务端会自动挂载首月优惠（0 元购）；
      // 传空 promo_campaign_id 可令响应 promo=null，按套餐全额实付
      ...(skipPromo ? { promo_campaign: { promo_campaign_id: '', is_coupon_from_query_param: false } } : {})
    }
  });
}
export async function sentinelReq(opts = {}) {
  // 自造 requirement token 作为 p：服务端用它加密 turnstile.dx，我们持有同一密钥可解
  const p = await getReqToken(opts);
  const r = await cgFetch('/backend-api/sentinel/req', { method: 'POST', body: { p }, ...opts });
  r.reqToken = p;
  return r;
}
export async function approve(token, sid, entity, sentinelToken, opts = {}, extraHeaders = {}) {
  return cgFetch('/backend-api/payments/checkout/approve', {
    method: 'POST', token, ...opts,
    headers: {
      referer: `https://chatgpt.com/checkout/${entity}/${sid}`,
      'x-openai-target-path': '/backend-api/payments/checkout/approve',
      'x-openai-target-route': '/backend-api/payments/checkout/approve',
      ...(sentinelToken ? { 'openai-sentinel-token': sentinelToken } : {}),
      ...extraHeaders
    },
    body: { checkout_session_id: sid, processor_entity: entity }
  });
}
export async function getSessionStatus(token, entity, sid, opts = {}) {
  return cgFetch(`/backend-api/payments/checkout/${entity}/${sid}`, { token, ...opts });
}
export async function getAccountStatus(token, opts = {}) {
  return cgFetch('/backend-api/accounts/check/v4-2023-04-27', { token, ...opts });
}
export async function cpmConfirm(token, sid, cpmt, opts = {}) {
  return cgFetch('/backend-api/payments/checkout/confirm', {
    method: 'POST', token, ...opts,
    body: { checkout_session_id: sid, type: 'custom_payment_method', selected_payment_method_type: cpmt, custom_payment_method_type_id: cpmt }
  });
}
export async function cpmStart(token, sid, cpmt, opts = {}) {
  return cgFetch('/backend-api/payments/checkout/custom_payment_method/start', {
    method: 'POST', token, ...opts,
    body: { checkout_session_id: sid, custom_payment_method_type_id: cpmt }
  });
}
