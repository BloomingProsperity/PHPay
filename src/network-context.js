import { DEFAULT_IMPERSONATION, IMPS } from './fprints.js';

const normalizedString = value => (typeof value === 'string' ? value.trim() : '');

export function effectiveProxy(value = '', env = process.env) {
  return [
    value,
    env?.CF_PROXY,
    env?.HTTPS_PROXY,
    env?.https_proxy,
  ].map(normalizedString).find(Boolean) || '';
}

export function effectiveImpersonation(value = '') {
  const v = normalizedString(value);
  return IMPS.includes(v) ? v : DEFAULT_IMPERSONATION;
}

export function normalizeNetworkContext(input = {}, env = process.env) {
  return {
    proxy: effectiveProxy(input?.proxy, env),
    imp: effectiveImpersonation(input?.imp),
  };
}
