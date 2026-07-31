import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { solveChallenge, clearSolveCache } from './solver.js';
import { normalizeNetworkContext } from './network-context.js';

const PY = process.env.PYTHON_BIN || 'python';
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cffetch.py');
const BASE = 'https://chatgpt.com';
const MAX_CHILD_OUTPUT_BYTES = 1024 * 1024;
const CHROME_131_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function rawCgFetch(p, { method = 'GET', token = '', headers = {}, body = null, proxy = '', imp = '' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(PY, [SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    let settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      fail(new Error('cffetch timed out'));
    }, 120000);
    let outBytes = 0, errBytes = 0;
    child.stdout.on('data', d => {
      outBytes += d.length;
      if (outBytes > MAX_CHILD_OUTPUT_BYTES) {
        child.kill('SIGKILL');
        fail(new Error(`cffetch stdout exceeded ${MAX_CHILD_OUTPUT_BYTES} byte limit`));
        return;
      }
      out += d;
    });
    child.stderr.on('data', d => {
      errBytes += d.length;
      if (errBytes > MAX_CHILD_OUTPUT_BYTES) {
        child.kill('SIGKILL');
        fail(new Error(`cffetch stderr exceeded ${MAX_CHILD_OUTPUT_BYTES} byte limit`));
        return;
      }
      err += d;
    });
    child.on('error', error => {
      clearTimeout(timer);
      fail(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (settled) return;
      if (code !== 0) {
        const detail = (err || out).trim().slice(0, 300);
        fail(new Error(`cffetch exited with code ${code}${signal ? ` (${signal})` : ''}${detail ? `: ${detail}` : ''}`));
        return;
      }
      try {
        const result = JSON.parse(out);
        settled = true;
        resolve(result);
      } catch {
        fail(new Error('cffetch returned invalid JSON: ' + (err || out).slice(0, 200)));
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ method, url: BASE + p, token, headers, body, proxy, impersonate: imp }));
  });
}

const CHALLENGE_TEXT = /just a moment|checking your browser|verify you are human|needs to review the security|attention required|\u8bf7\u7a0d\u5019|\u6b63\u5728\u68c0\u67e5\u60a8\u7684\u6d4f\u89c8\u5668/i;

function responseHeader(response, wanted) {
  const normalizedWanted = wanted.toLowerCase().replace(/[^a-z0-9]/g, '');
  const entry = Object.entries(response?.headers || {}).find(([key]) => (
    key.toLowerCase().replace(/[^a-z0-9]/g, '') === normalizedWanted
  ));
  return entry ? String(entry[1] ?? '') : '';
}

export function isChallengeResponse(response) {
  if (responseHeader(response, 'cfMitigated').trim().toLowerCase() === 'challenge') return true;
  if (![403, 429, 503].includes(Number(response?.status))) return false;
  if (!responseHeader(response, 'contentType').toLowerCase().includes('text/html')) return false;
  return CHALLENGE_TEXT.test(String(response?.html || ''));
}

function clearanceCookie(cookieHeader) {
  for (const part of String(cookieHeader || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name === 'cf_clearance' && value) return `cf_clearance=${value}`;
  }
  return '';
}

function replayHeaders(input, cookie, ua) {
  const headers = { ...(input || {}) };
  const originalCookies = [];
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== 'cookie') continue;
    for (const part of String(headers[key] || '').split(';')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const separator = trimmed.indexOf('=');
      const name = (separator < 0 ? trimmed : trimmed.slice(0, separator)).trim();
      if (name.toLowerCase() !== 'cf_clearance') originalCookies.push(trimmed);
    }
    delete headers[key];
  }
  headers.Cookie = [...originalCookies, cookie].join('; ');
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === 'user-agent') delete headers[key];
  }
  headers['User-Agent'] = String(ua || '').trim() || CHROME_131_UA;
  return headers;
}

export class CloudflareChallengeError extends Error {
  constructor(message = 'Cloudflare challenge could not be solved', options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'CloudflareChallengeError';
    this.code = 'cloudflare_challenge_failed';
  }
}

const challengeFailure = (message, cause) => (
  new CloudflareChallengeError(message, cause ? { cause } : {})
);

export function createCgFetch({ rawFetch, solve, clear }) {
  return async function cgFetchWithChallenge(p, opts = {}) {
    const network = normalizeNetworkContext(opts);
    const normalizedOpts = { ...opts, ...network };
    const url = BASE + p;
    const first = await rawFetch(p, normalizedOpts);
    if (!isChallengeResponse(first)) return first;

    let solution;
    try {
      solution = await solve(
        url,
        network.proxy,
        first.html || '',
        network.imp,
        {
          method: String(normalizedOpts.method || 'GET').toUpperCase(),
          token: String(normalizedOpts.token || ''),
          headers: { ...(normalizedOpts.headers || {}) },
          body: normalizedOpts.body ?? null,
        },
      );
    } catch (cause) {
      throw challengeFailure('Cloudflare challenge solver failed', cause);
    }

    if (solution?.directResponse) {
      if (!isChallengeResponse(solution.directResponse)) return solution.directResponse;
      try {
        await clear(url, network.proxy);
      } catch {}
      throw challengeFailure('Cloudflare challenge remained in local browser fallback');
    }

    const cookie = clearanceCookie(solution?.cookieHeader);
    if (solution?.cleared !== true || !cookie) {
      throw challengeFailure('Cloudflare challenge was not solved');
    }

    const headers = replayHeaders(normalizedOpts.headers, cookie, solution.ua);
    const replay = await rawFetch(p, { ...normalizedOpts, headers });
    if (!isChallengeResponse(replay)) return replay;

    try {
      await clear(url, network.proxy);
    } catch {}
    throw challengeFailure('Cloudflare challenge remained after clearance replay');
  };
}

export const cgFetch = createCgFetch({
  rawFetch: rawCgFetch,
  solve: solveChallenge,
  clear: clearSolveCache,
});

export async function resolveToken(input, opts = {}) {
  const t = String(input || '').trim();
  if (!t) throw new Error('账号信息为空');
  if (t.startsWith('{')) {
    const j = JSON.parse(t);
    if (j.accessToken) return { token: j.accessToken, email: j.user?.email || '' };
    if (j.sessionToken) return exchangeSessionToken(j.sessionToken, opts);
    throw new Error('JSON 里没有 accessToken/sessionToken');
  }
  if (t.startsWith('eyJ')) {
    const segs = t.split('.').length - 1;
    if (segs === 4) return exchangeSessionToken(t, opts);
    return { token: t, email: '' };
  }
  throw new Error('无法识别的格式：支持 session JSON / accessToken / sessionToken');
}

export async function exchangeSessionToken(sessionToken, opts = {}) {
  const { cgFetchFn = cgFetch, ...requestOpts } = opts;
  let r;
  try {
    r = await cgFetchFn('/api/auth/session', {
      headers: { Cookie: '__Secure-next-auth.session-token=' + sessionToken },
      ...requestOpts,
    });
  } catch (error) {
    if (error?.code === 'cloudflare_challenge_failed' || error?.code === 'invalid_account_credential') throw error;
    throw sessionExchangeError('account_status_check_failed', 'sessionToken exchange temporarily failed', error?.status, error);
  }
  if (Number(r?.status) === 401) {
    throw sessionExchangeError('invalid_account_credential', 'sessionToken credential was rejected', 401);
  }
  if (!Number.isInteger(r?.status) || r.status < 200 || r.status >= 300) {
    throw sessionExchangeError('account_status_check_failed', 'sessionToken exchange temporarily failed', r?.status);
  }
  const j = r.json || {};
  if (!j.accessToken) {
    throw sessionExchangeError('account_status_check_failed', 'sessionToken exchange returned no access token', r.status);
  }
  return { token: j.accessToken, email: j.user?.email || '' };
}

function sessionExchangeError(code, message, status, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  if (Number.isInteger(Number(status))) error.status = Number(status);
  return error;
}
