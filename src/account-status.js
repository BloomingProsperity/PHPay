import { resolveToken } from './browser.js';
import * as cg from './chatgpt.js';
import { normalizePlanTier } from './plan-tier.js';

export { normalizePlanTier } from './plan-tier.js';

export function normalizeAccountStatus(payload = {}) {
  const accounts = payload.accounts && typeof payload.accounts === 'object' ? Object.values(payload.accounts) : [];
  const classified = accounts.filter(account => typeof account?.entitlement?.has_active_subscription === 'boolean');
  if (!classified.length || classified.length !== accounts.length) {
    throw accountStatusError('unrecognized account status response');
  }
  const activePlans = classified
    .filter(account => account.entitlement.has_active_subscription === true)
    .map(account => normalizePlanTier(account.entitlement.subscription_plan));
  if (!activePlans.length) return { state: 'free', plan: 'chatgptfreeplan', errorCode: '' };
  if (activePlans.some(plan => !plan) || new Set(activePlans).size !== 1) {
    throw accountStatusError('unrecognized active subscription plans');
  }
  return { state: 'active', plan: activePlans[0], errorCode: '' };
}

export async function detectAccountStatus(sessionJson, opts = {}) {
  const {
    token: providedToken = '',
    includeCredential = false,
    resolveTokenFn = resolveToken,
    getAccountStatusFn = cg.getAccountStatus,
    ...requestOpts
  } = opts;
  try {
    const parsedSession = parsedCredential(sessionJson);
    const initial = providedToken
      ? { token: providedToken, email: parsedSession?.user?.email || '' }
      : await resolveTokenFn(
          typeof sessionJson === 'string' ? sessionJson : JSON.stringify(sessionJson),
          requestOpts
        );
    let effectiveToken = initial.token;
    let effectiveEmail = String(initial.email || parsedSession?.user?.email || '');
    let response = await getAccountStatusFn(effectiveToken, requestOpts);
    if (isCredentialRejection(response)) {
      const sessionFallback = fallbackSessionCredential(sessionJson);
      if (!sessionFallback) {
        return { state: 'invalid', plan: '', errorCode: 'invalid_account_credential' };
      }
      const refreshed = await resolveTokenFn(JSON.stringify(sessionFallback), requestOpts);
      effectiveToken = refreshed.token;
      effectiveEmail = String(refreshed.email || effectiveEmail);
      response = await getAccountStatusFn(effectiveToken, requestOpts);
      if (isCredentialRejection(response)) {
        return { state: 'invalid', plan: '', errorCode: 'invalid_account_credential' };
      }
    }
    if (!Number.isInteger(response?.status) || response.status < 200 || response.status >= 300) {
      return { state: 'error', plan: '', errorCode: 'account_status_check_failed' };
    }
    const status = normalizeAccountStatus(response.json);
    return includeCredential
      ? { ...status, token: effectiveToken, email: effectiveEmail }
      : status;
  } catch (error) {
    if (String(error?.code || '').toLowerCase() === 'invalid_account_credential' || Number(error?.status) === 401) {
      return { state: 'invalid', plan: '', errorCode: 'invalid_account_credential' };
    }
    return { state: 'error', plan: '', errorCode: 'account_status_check_failed' };
  }
}

function parsedCredential(value) {
  try {
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    return null;
  }
}

function isCredentialRejection(response) {
  const providerCode = String(response?.json?.error?.code || response?.json?.code || '').toLowerCase();
  return response?.status === 401 || providerCode === 'invalid_account_credential';
}

function fallbackSessionCredential(value) {
  const parsed = parsedCredential(value);
  if (!parsed?.accessToken || !parsed?.sessionToken) return null;
  return { sessionToken: parsed.sessionToken };
}

function accountStatusError(message) {
  const error = new Error(message);
  error.code = 'account_status_check_failed';
  return error;
}
