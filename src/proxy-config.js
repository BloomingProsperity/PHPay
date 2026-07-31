import fs from 'node:fs';
import path from 'node:path';

export function normalizeProxy(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  let candidate = raw;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    const parts = candidate.split(':');
    if (parts.length === 2) {
      candidate = `http://${parts[0]}:${parts[1]}`;
    } else if (parts.length >= 4) {
      const [host, port, user, ...passwordParts] = parts;
      candidate = `http://${encodeURIComponent(user)}:${encodeURIComponent(passwordParts.join(':'))}@${host}:${port}`;
    } else {
      return '';
    }
  }
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    if (!url.hostname || !Number.isInteger(port) || port < 1 || port > 65535) return '';
    return url.toString();
  } catch {
    return '';
  }
}

export function parseProxyLines(text) {
  const proxies = [];
  const seen = new Set();
  let duplicate = 0;
  let invalid = 0;
  for (const source of String(text || '').split(/[\r\n,，]+/)) {
    const row = source.trim();
    if (!row || /^proxy$/i.test(row)) continue;
    const proxy = normalizeProxy(row);
    if (!proxy) {
      invalid++;
    } else if (seen.has(proxy)) {
      duplicate++;
    } else {
      seen.add(proxy);
      proxies.push(proxy);
    }
  }
  return { proxies, valid: proxies.length, duplicate, invalid };
}

function maskProxy(proxy) {
  try {
    const url = new URL(proxy);
    if (url.username || url.password) {
      url.username = url.username ? '***' : '';
      url.password = url.password ? '***' : '';
    }
    return url.toString().replace(/%2A/gi, '*');
  } catch {
    return '';
  }
}

function readSaved(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed?.proxies)
      ? parsed.proxies.map(normalizeProxy).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

function writeAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

export function createProxyConfig({ file, env = process.env, testRequest, now = Date.now } = {}) {
  if (!file) throw new Error('proxy config file is required');
  let saved = readSaved(file);
  const healthByProxy = new Map();
  const envPool = parseProxyLines(String(env.PROXY_POOL || '').replace(/,/g, '\n')).proxies;
  const fallback = [
    normalizeProxy(env.CF_PROXY),
    normalizeProxy(env.HTTPS_PROXY)
  ].filter(Boolean);

  const sourceAndPool = () => {
    if (envPool.length) return { source: 'environment_pool', locked: true, pool: envPool };
    if (saved.length) return { source: 'saved', locked: false, pool: saved };
    if (fallback.length) return { source: 'environment_fallback', locked: false, pool: [fallback[0]] };
    return { source: 'direct', locked: false, pool: [] };
  };

  const publicView = () => {
    const current = sourceAndPool();
    return {
      source: current.source,
      locked: current.locked,
      count: current.pool.length,
      items: current.pool.map((proxy, index) => ({ index, label: maskProxy(proxy) }))
    };
  };

  const replace = values => {
    if (envPool.length) return { ok: false, error: 'proxy_pool_managed_by_environment' };
    const parsed = parseProxyLines(Array.isArray(values) ? values.join('\n') : values);
    if (!parsed.proxies.length && parsed.invalid) {
      return { ok: false, error: 'no_valid_proxy', ...parsed };
    }
    saved = parsed.proxies;
    for (const proxy of healthByProxy.keys()) {
      if (!saved.includes(proxy) && !envPool.includes(proxy) && !fallback.includes(proxy)) {
        healthByProxy.delete(proxy);
      }
    }
    writeAtomic(file, { proxies: saved });
    return { ok: true, ...parsed, view: publicView() };
  };

  const clear = () => replace([]);

  const remove = index => {
    if (envPool.length) return { ok: false, error: 'proxy_pool_managed_by_environment' };
    const position = Number(index);
    if (!Number.isInteger(position) || position < 0 || position >= saved.length) {
      return { ok: false, error: 'proxy_not_found' };
    }
    saved.splice(position, 1);
    writeAtomic(file, { proxies: saved });
    return { ok: true, view: publicView() };
  };

  const proxyFor = slot => {
    const pool = sourceAndPool().pool;
    if (!pool.length) return '';
    const index = Math.abs(Number(slot) || 0) % pool.length;
    return pool[index];
  };

  const test = async proxy => {
    const normalized = normalizeProxy(proxy);
    if (!normalized) return { ok: false, error: 'invalid_proxy' };
    if (typeof testRequest !== 'function') return { ok: false, error: 'proxy_test_unavailable' };
    const started = Date.now();
    try {
      const result = await testRequest(normalized);
      return { ok: true, latencyMs: Date.now() - started, detail: result?.detail || '' };
    } catch {
      return { ok: false, error: 'proxy_connection_failed' };
    }
  };

  const testAt = async index => {
    const pool = sourceAndPool().pool;
    const position = Number(index);
    if (!Number.isInteger(position) || position < 0 || position >= pool.length) {
      return { ok: false, error: 'proxy_not_found' };
    }
    const proxy = pool[position];
    const result = await test(proxy);
    healthByProxy.set(proxy, { ...result, checkedAt: now() });
    return result;
  };

  const recordHealthAt = (index, result = {}) => {
    const pool = sourceAndPool().pool;
    const position = Number(index);
    if (!Number.isInteger(position) || position < 0 || position >= pool.length) return false;
    healthByProxy.set(pool[position], {
      ok: result.ok === true,
      ...(Number.isFinite(result.latencyMs) ? { latencyMs: Math.max(0, Math.round(result.latencyMs)) } : {}),
      ...(result.ok === true ? {} : { error: String(result.error || 'proxy_connection_failed') }),
      checkedAt: now()
    });
    return true;
  };

  const snapshot = () => [...sourceAndPool().pool];

  const cachedHealthAt = (index, maxAgeMs = 120_000) => {
    const pool = sourceAndPool().pool;
    const position = Number(index);
    if (!Number.isInteger(position) || position < 0 || position >= pool.length) return null;
    const result = healthByProxy.get(pool[position]);
    const age = now() - Number(result?.checkedAt);
    if (!result || !Number.isFinite(age) || age < 0 || age > Math.max(0, Number(maxAgeMs) || 0)) return null;
    return { ...result };
  };

  return {
    publicView,
    replace,
    clear,
    remove,
    proxyFor,
    test,
    testAt,
    recordHealthAt,
    snapshot,
    cachedHealthAt
  };
}
