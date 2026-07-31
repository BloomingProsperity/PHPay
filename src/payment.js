import * as cg from './chatgpt.js';
import { resolveToken } from './browser.js';
import * as stripe from './stripe.js';
import { solvePow } from './pow.js';
import { processTurnstile } from './turnstile.js';
import { randomName } from './cardparse.js';
import { classifyPaymentStatus } from './payment-status.js';
import { detectAccountStatus, normalizePlanTier } from './account-status.js';
import { normalizeNetworkContext } from './network-context.js';

const productionPaymentDependencies = Object.freeze({
  resolveToken,
  detectAccountStatus,
  createSession: cg.createSession,
  normalizeNetworkContext,
  cg,
  stripe,
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms))
});

export function assertAccountCanSubscribe(status = {}, targetPlan = '') {
  const normalized = normalizeSubscriptionStatus(status);
  const normalizedTargetPlan = normalizePlanTier(targetPlan);
  if (!normalizedTargetPlan) {
    const error = new Error('所选目标套餐不受支持，已停止支付');
    error.code = 'unsupported_target_plan';
    throw error;
  }
  if (normalized.state === 'free') return normalized;
  if (normalized.state === 'active' && normalized.plan && normalizedTargetPlan) {
    if (normalized.plan !== normalizedTargetPlan) return normalized;
    const error = new Error('账号已经订阅目标套餐，已停止支付');
    error.code = 'account_already_on_target_plan';
    throw error;
  }
  const code = normalized.state === 'invalid'
      ? 'invalid_account_credential'
      : 'account_status_check_failed';
  const message = code === 'invalid_account_credential'
      ? '账号凭证无效，已停止支付'
      : '账号状态无法确认，已停止支付';
  const error = new Error(message);
  error.code = code;
  throw error;
}

function normalizeSubscriptionStatus(status = {}) {
  const state = String(status.state || '').trim().toLowerCase();
  return {
    state,
    plan: state === 'free'
      ? 'chatgptfreeplan'
      : state === 'active'
        ? normalizePlanTier(status.plan)
        : '',
    errorCode: String(status.errorCode || '')
  };
}

export function createPaymentFlows(overrides = {}) {
  const dependencies = {
    ...productionPaymentDependencies,
    ...overrides,
    cg: { ...cg, ...(overrides.cg || {}) },
    stripe: { ...stripe, ...(overrides.stripe || {}) }
  };
  return {
    runLink: (input, emit) => runLink(input, emit, dependencies),
    runPay: (input, emit, hooks = {}) => runPay(input, emit, hooks, dependencies)
  };
}

function validateAndEmitAccountStatus(status, emit, targetPlan, hooks = {}) {
  const st = normalizeSubscriptionStatus(status);
  const label = { active: '订阅中', free: '免费账号', invalid: '凭证无效', error: '检测失败', pending: '检测中', unknown: '未知' }[st.state] || st.state;
  emit(8, `账号状态: ${label}${st.plan ? ' / ' + st.plan : ''}${st.errorCode ? ' (' + st.errorCode + ')' : ''}`, st.state === 'invalid' ? 'err' : undefined);
  hooks.onAccountStatus?.({ accountPlanBefore: st.plan });
  return assertAccountCanSubscribe(st, targetPlan);
}

// 支付前置：识别账号状态（free / plus / pro…），invalid 快速失败
async function emitAccountStatus(sessionJson, emit, opts, targetPlan, hooks = {}, dependencies = productionPaymentDependencies) {
  const status = await dependencies.detectAccountStatus(sessionJson, opts);
  return validateAndEmitAccountStatus(status, emit, targetPlan, hooks);
}
export function validateCard(card) {
  const [expM, expY] = String(card.exp || '').split('/').map(s => s.trim());
  const num = String(card.number || '').replace(/\D/g, '');
  const cvc = String(card.cvc || '').trim();
  if (!/^\d{13,19}$/.test(num) || !isLuhnValid(num)) throw new Error('invalid card number');
  if (!/^(0[1-9]|1[0-2])$/.test(expM) || !/^\d{2}(?:\d{2})?$/.test(expY)) throw new Error('invalid expiration');
  const year = expY.length === 2 ? 2000 + Number(expY) : Number(expY);
  const current = new Date();
  if (year < current.getUTCFullYear() || (year === current.getUTCFullYear() && Number(expM) < current.getUTCMonth() + 1)) throw new Error('expired card');
  if (!/^\d{13,19}$/.test(num)) throw new Error('卡号格式不对（13-19位数字）');
  if (!/^\d{1,2}$/.test(expM) || !/^\d{2,4}$/.test(expY)) throw new Error('有效期格式不对（MM/YY）');
  if (!/^\d{3,4}$/.test(cvc)) throw new Error('CVC 格式不对（3-4位）');
  return { number: num, exp: expM + '/' + expY, cvc, name: String(card.name || '').trim() || randomName() };
}

export function recordActualAmount(due, currency, hooks = {}) {
  if (!Number.isSafeInteger(due) || due < 0) {
    const error = new Error('页面实际应付金额缺失，已停止支付');
    error.code = 'actual_amount_unavailable';
    throw error;
  }
  hooks.onAmount?.({ amount: due, currency });
  if (due === 0) {
    const error = new Error('页面实际应付金额为 0，已停止支付');
    error.code = 'zero_amount_offer';
    throw error;
  }
  return due;
}

export function extractActualAmount(init) {
  const amount = init?.j?.invoice?.amount_due;
  if (!Number.isSafeInteger(amount) || amount < 0) {
    const error = new Error('页面实际应付金额不可用，已停止支付');
    error.code = 'actual_amount_unavailable';
    throw error;
  }
  return amount;
}

export function classifyProviderPaymentError(error = {}) {
  if (String(error.code || '').toLowerCase() === 'authentication_required') return 'unknown';
  if (error.decline_code || error.type === 'card_error') return 'failed';
  return new Set([
    'card_declined',
    'insufficient_funds',
    'expired_card',
    'incorrect_cvc',
    'invalid_cvc',
    'incorrect_number',
    'invalid_number',
    'processing_error',
    'payment_intent_authentication_failure',
    'canceled',
    'cancelled',
    'expired'
  ]).has(String(error.code || '').toLowerCase())
     ? 'failed'
     : 'unknown';
}

export function paymentErrorFromPayload(payload = {}) {
  const candidates = [
    payload.error,
    payload.submission_attempt?.error?.payment_error,
    payload.submission_attempt?.error,
    payload.payment_intent?.last_payment_error,
    payload.setup_intent?.last_setup_error
  ];
  return candidates.find(value => (
    value
    && typeof value === 'object'
    && Object.values(value).some(Boolean)
  )) || null;
}

export function isPrepaymentInvoiceMismatch(payload = {}) {
  const error = paymentErrorFromPayload(payload);
  if (String(error?.code || '') !== 'checkout_upcoming_invoice_mismatch') return false;
  if (payload.submission_attempt?.state !== 'failed') return false;
  if (payload.payment_intent?.id || payload.payment_intent?.client_secret) return false;
  if (payload.next_action || payload.payment_intent?.next_action) return false;
  return true;
}

function payloadFailureState(payload, error = paymentErrorFromPayload(payload)) {
  if (!error) return '';
  if (String(error.code || '') === 'checkout_upcoming_invoice_mismatch') {
    return isPrepaymentInvoiceMismatch(payload) ? 'failed' : 'unknown';
  }
  return classifyProviderPaymentError(error);
}

function assertCheckoutPlan(payload, selectedPlan) {
  if (String(payload?.plan_name || '').trim() === selectedPlan) return;
  const error = new Error('平台返回的结算套餐与所选套餐不一致，已停止支付');
  error.code = 'checkout_plan_mismatch';
  throw error;
}
function isLuhnValid(number) {
  let sum = 0;
  let shouldDouble = false;
  for (let index = number.length - 1; index >= 0; index--) {
    let digit = Number(number[index]);
    if (shouldDouble) { digit *= 2; if (digit > 9) digit -= 9; }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}
async function createCsLive(token, plan, emit, opts, dependencies = productionPaymentDependencies, rejectPromotions = false) {
  const skipPromo = opts.skipPromo !== false;
  const r = await dependencies.createSession(token, { plan, ...opts, skipPromo });
  const d = r.json;
  if (!d.checkout_session_id) throw new Error('创建会话失败: ' + JSON.stringify(d).slice(0, 200));
  const kind = d.checkout_session_id.startsWith('cs_') ? 'cs_live_(Stripe 原生)' : 'oaics_(open_ai 收银台)';
  emit(25, `会话 ${d.checkout_session_id.slice(0, 14)}… [${kind}]`);
  if (skipPromo) {
    if (d.promo_campaign) emit(26, `⚠ 已请求绕过但服务端仍挂载优惠: ${d.promo_campaign.promo_campaign_id || 'unknown'}`, 'warn');
    else emit(26, '优惠挂载已绕过（promo=null，按套餐全额实付）');
  }
  const flags = [
    'promo_campaign',
    'promo_credit_grant',
    'credit_discount_offer',
    'one_click_trial_eligible',
    'trial',
    'discount'
  ].filter(key => Boolean(d[key]));
  if (flags.length && rejectPromotions) {
    const error = new Error(`支付会话挂载了优惠或试用标记: ${flags.join(', ')}`);
    error.code = 'promotional_offer_attached';
    throw error;
  }
  if (flags.length) emit(28, `⚠ 会话带优惠/试用标记: ${flags.join(' ')}`, 'warn');
  return d;
}
export async function runLink({ sessionJson, plan = 'chatgptpro', proxy = '', imp = '', skipPromo = true }, emit, dependencies = productionPaymentDependencies) {
  const network = dependencies.normalizeNetworkContext({ proxy, imp });
  const opts = { ...network, skipPromo };
  const { token, email } = await dependencies.resolveToken(typeof sessionJson === 'string' ? sessionJson : JSON.stringify(sessionJson), opts);
  emit(5, `解析账号… ${email}`);
  await emitAccountStatus(sessionJson, emit, { ...opts, token }, plan, {}, dependencies);
  const d = await createCsLive(token, plan, emit, opts, dependencies);
  const cs = d.checkout_session_id, pk = d.publishable_key;
  const entity = d.processor_entity || 'openai_llc';
  const out = { short: `https://chatgpt.com/checkout/${entity}/${cs}` };
  const cpmt = (d.custom_payment_methods || [])[0]?.id;
  // 并行：托管链接 init 与 GCash confirm 互不依赖
  const [init, cf] = await Promise.all([
    cs.startsWith('cs_') ? dependencies.stripe.init(cs, pk, network.proxy) : Promise.resolve(null),
    cpmt ? dependencies.cg.cpmConfirm(token, cs, cpmt, opts) : Promise.resolve(null)
  ]);
  if (init) {
    out.hosted = (init.j.stripe_hosted_url || init.j.hosted_url || '');
    if (out.hosted) {
      out.hosted = out.hosted.replace('https://checkout.stripe.com', 'https://pay.openai.com');
      emit(70, '托管链接已生成');
    } else emit(70, 'init 未返回托管链接');
  }
  if (cf?.status === 200) {
    const st = await dependencies.cg.cpmStart(token, cs, cpmt, opts);
    if (st.json?.next_action?.url) {
      out.gcash = st.json.next_action.url;
      emit(95, `${st.json.next_action.paymentMethodType || 'gcash'} 链接已生成`);
    }
  }
  emit(100, '—— 链接生成完毕 ——');
  return out;
}
export async function runPay({ sessionJson, card, address, plan = 'chatgptpro', proxy = '', imp = '', skipPromo = true }, emit, hooks = {}, dependencies = productionPaymentDependencies) {
  void skipPromo;
  const network = dependencies.normalizeNetworkContext({ proxy, imp });
  const opts = { ...network, skipPromo: true };
  card = validateCard(card);
  const trustedContext = (
    typeof hooks.accountContext?.token === 'string'
    && hooks.accountContext.token
    && hooks.accountContext.status
    && typeof hooks.accountContext.status === 'object'
  ) ? hooks.accountContext : null;
  const { token, email } = trustedContext
    ? { token: trustedContext.token, email: String(trustedContext.email || '') }
    : await dependencies.resolveToken(typeof sessionJson === 'string' ? sessionJson : JSON.stringify(sessionJson), opts);
  emit(5, `解析账号… ${email}`);
  if (trustedContext) {
    validateAndEmitAccountStatus(trustedContext.status, emit, plan, hooks);
  } else {
    await emitAccountStatus(sessionJson, emit, { ...opts, token }, plan, hooks, dependencies);
  }
  const d = await createCsLive(token, plan, emit, opts, dependencies, true);
  assertCheckoutPlan(d, plan);
  const cs = d.checkout_session_id, pk = d.publishable_key;
  const entity = d.processor_entity || 'openai_llc';
  const short = `https://chatgpt.com/checkout/${entity}/${cs}`;
  hooks.onCheckoutCreated?.({ checkoutSessionId: cs, processorEntity: entity, email });
  const currency = d.billing_details?.currency || 'PHP';
  const loadCurrentPricing = async () => {
    const initialized = await dependencies.stripe.init(cs, pk, network.proxy);
    const currentChecksum = initialized.j.init_checksum;
    if (!currentChecksum) {
      const error = new Error('Stripe init did not return a checksum');
      error.code = 'payment_execution_failed';
      throw error;
    }
    const currentDue = extractActualAmount(initialized);
    recordActualAmount(currentDue, currency, hooks);
    return {
      checksum: currentChecksum,
      due: currentDue,
      hosted: (initialized.j.stripe_hosted_url || initialized.j.hosted_url || '').replace('https://checkout.stripe.com', 'https://pay.openai.com')
    };
  };
  emit(35, '创建 PaymentMethod、Stripe init 与 Sentinel 预检（并行）…');
  const [pm, sentinel, initialPricing] = await Promise.all([
    dependencies.stripe.createPM(card, address, pk, network.proxy),
    prepareSentinel(opts, emit, dependencies),
    loadCurrentPricing()
  ]);
  if (!pm.j.id) {
    const providerError = paymentErrorFromPayload(pm.j);
    const error = new Error('payment method creation failed');
    error.code = String(providerError?.code || 'payment_execution_failed');
    error.providerError = providerError || {};
    throw error;
  }
  let pricing = initialPricing;
  let { checksum, due, hosted } = pricing;
  emit(58, `init OK，应付 ${(due / 100).toFixed(2)} ${d.billing_details?.currency || 'PHP'}`);
  emit(68, '提交 confirm…');
  hooks.onStage?.({ stage: 'confirm_started' });
  let cf;
  try {
    cf = await dependencies.stripe.confirm(
      cs,
      pm.j.id,
      checksum,
      due,
      entity,
      dependencies.cg.PLANS[plan]?.planType || 'pro',
      pk,
      network.proxy
    );
  } catch (error) {
    return unknownPaymentResult({ due, currency, cs, entity, short, hosted, error });
  }
  if (isPrepaymentInvoiceMismatch(cf.j)) {
    emit(72, '应付金额已变化，正在按同一套餐的最新金额重新确认一次…', 'warn');
    const previousDue = due;
    let repriced = null;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await dependencies.sleep(1000);
      const candidate = await loadCurrentPricing();
      if (candidate.due !== previousDue) {
        repriced = candidate;
        break;
      }
    }
    if (repriced) {
      pricing = repriced;
      ({ checksum, due, hosted } = pricing);
      try {
        cf = await dependencies.stripe.confirm(
          cs,
          pm.j.id,
          checksum,
          due,
          entity,
          dependencies.cg.PLANS[plan]?.planType || 'pro',
          pk,
          network.proxy
        );
      } catch (error) {
        return unknownPaymentResult({ due, currency, cs, entity, short, hosted, error });
      }
    }
  }
  const confirmError = paymentErrorFromPayload(cf.j);
  if (confirmError) {
    const e = confirmError;
    const authentication = String(e.code || '').toLowerCase() === 'authentication_required';
    const authenticationState = authentication ? classifyPaymentStatus(cf.j) : null;
    if (authenticationState?.state === 'pending_3ds') {
      return {
        ok: false,
        state: 'pending_3ds',
        amount: due,
        currency,
        checkoutSessionId: cs,
        processorEntity: entity,
        verificationUrl: authenticationState.verificationUrl,
        short,
        hosted
      };
    }
    if (payloadFailureState(cf.j, e) === 'failed') {
      emit(100, `✗ 支付被拒: ${e.code || ''} / ${e.decline_code || ''} ${(e.message || '').slice(0, 120)}`, 'err');
      return { ok: false, state: 'failed', stage: 'confirm', error: e, amount: due, currency, checkoutSessionId: cs, processorEntity: entity, short, hosted };
    }
    return unknownPaymentResult({ due, currency, cs, entity, short, hosted });
  }
  const confirmFailure = explicitTerminalFailure(cf.j);
  if (confirmFailure) {
    return {
      ok: false,
      state: 'failed',
      stage: 'confirm',
      error: { code: confirmFailure },
      amount: due,
      currency,
      checkoutSessionId: cs,
      processorEntity: entity,
      short,
      hosted
    };
  }
  emit(82, `confirm ${cf.j.submission_attempt?.state || cf.j.status}，approve…`);
  const immediate = classifyPaymentStatus(cf.j);
  if (immediate.state === 'pending_3ds') {
    return {
      ok: false,
      state: 'pending_3ds',
      amount: due,
      currency,
      checkoutSessionId: cs,
      processorEntity: entity,
      verificationUrl: immediate.verificationUrl,
      short,
      hosted
    };
  }
  let ap;
  try {
    hooks.onStage?.({ stage: 'approve_started' });
    ap = await dependencies.cg.approve(token, cs, entity, sentinel.token, opts, sentinel.extra);
  } catch (error) {
    return unknownPaymentResult({ due, currency, cs, entity, short, hosted, error });
  }
  const result = ap.json?.result;
  emit(88, `approve ${ap.status}: ${JSON.stringify(ap.json).slice(0, 80)}`, result === 'blocked' ? 'err' : undefined);
  if (['declined', 'canceled', 'cancelled', 'expired'].includes(result)) {
    const error = ap.json?.error || { code: result };
    return { ok: false, state: 'failed', stage: 'approve', error, amount: due, currency, checkoutSessionId: cs, processorEntity: entity, short, hosted };
  }
  if (result === 'blocked') {
    emit(100, '⚠ approve 被风控拦截，支付结果未决', 'warn');
    return unknownPaymentResult({ due, currency, cs, entity, short, hosted });
  }
  emit(92, '轮询支付结果…');
  hooks.onStage?.({ stage: 'polling' });
  let final = { ok: false, state: 'unknown' };
  for (let i = 0; i < 12; i++) {
    if (i > 0) await dependencies.sleep(1000);
    let poll;
    try {
      poll = await dependencies.stripe.pollSession(cs, pk, network.proxy);
    } catch (error) {
      return unknownPaymentResult({ due, currency, cs, entity, short, hosted, error });
    }
    const j = poll.j;
    if (j.error?.code === 'checkout_not_active_session') {
      let chk;
      try {
        chk = await dependencies.cg.getSessionStatus(token, entity, cs, opts);
      } catch (error) {
        return unknownPaymentResult({ due, currency, cs, entity, short, hosted, error });
      }
      final = chk.json?.status === 'complete'
        ? { ok: true, state: 'succeeded' }
        : ['canceled', 'cancelled', 'expired'].includes(chk.json?.status)
          ? { ok: false, state: 'failed', error: { code: chk.json.status } }
          : { ok: false, state: 'unknown' };
      break;
    }
    const sub = j.submission_attempt;
    const err = paymentErrorFromPayload(j);
    if (err) {
      final = payloadFailureState(j, err) === 'failed'
        ? { ok: false, state: 'failed', error: err }
        : { ok: false, state: 'unknown' };
      break;
    }
    if (explicitTerminalFailure(j)) {
      final = { ok: false, state: 'failed', error: { code: explicitTerminalFailure(j) } };
      break;
    }
    const classified = classifyPaymentStatus(j);
    if (classified.state === 'succeeded') { final = { ok: true, state: 'succeeded' }; break; }
    if (classified.state === 'pending_3ds') {
      final = { ok: false, state: 'pending_3ds', challenge: true, verificationUrl: classified.verificationUrl };
      break;
    }
  }
  if (final?.ok) emit(100, '✓ 支付成功，订阅已开通！', 'ok');
  else if (final?.challenge) emit(100, '⚠ 需要人机/3DS 挑战，请在浏览器中完成', 'warn');
  else if (final?.error) emit(100, `✗ 被拒: ${final.error.code || ''} / ${final.error.decline_code || ''}`, 'err');
  else emit(100, '⚠ 状态未决，请到账号内确认订阅状态', 'warn');
  return {
    ok: !!final?.ok,
    state: final.state,
    final,
    amount: due,
    currency,
    checkoutSessionId: cs,
    processorEntity: entity,
    verificationUrl: final.verificationUrl || '',
    short,
    hosted
  };
}

async function prepareSentinel(opts, emit, dependencies) {
  const response = await dependencies.cg.sentinelReq(opts);
  const extra = {};
  const powReq = response.json?.proofofwork;
  if (powReq?.required) {
    const t0 = Date.now();
    const pow = solvePow(powReq.seed, powReq.difficulty, 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
    if (pow) {
      extra['openai-sentinel-proof-token'] = pow;
      emit(84, `PoW 已解（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
    } else emit(84, 'PoW 求解失败，按无证明提交', 'warn');
  }
  const tsReq = response.json?.turnstile;
  if (tsReq?.required && tsReq.dx && response.reqToken) {
    const t0 = Date.now();
    try {
      const token = processTurnstile(tsReq.dx, response.reqToken);
      if (token) {
        extra['openai-sentinel-turnstile-token'] = token;
        emit(85, `Turnstile 令牌已生成（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
      } else emit(85, 'Turnstile 令牌为空，按无令牌提交', 'warn');
    } catch (error) {
      emit(85, 'Turnstile 求解失败: ' + (error.message || error), 'warn');
    }
  }
  return { token: response.json?.token || '', extra };
}

function unknownPaymentResult({ due, currency, cs, entity, short, hosted, error }) {
  return {
    ok: false,
    state: 'unknown',
    final: { ok: false, state: 'unknown', ...(error ? { transportError: true } : {}) },
    amount: due,
    currency,
    checkoutSessionId: cs,
    processorEntity: entity,
    verificationUrl: '',
    short,
    hosted
  };
}

function explicitTerminalFailure(payload = {}) {
  const states = [
    payload.status,
    payload.payment_status,
    payload.payment_intent?.status,
    payload.setup_intent?.status,
    payload.submission_attempt?.state
  ];
  return states.find(value => ['canceled', 'cancelled', 'expired'].includes(value)) || '';
}
